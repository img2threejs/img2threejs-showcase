# Design System

## Source Of Truth

This repository’s visual language is extracted from `src/styles.css`.
Do not redesign the UI here. Treat the CSS as canonical and keep this document in sync with it.

## Design Language

The app uses a dark, technical-gallery aesthetic: layered glass surfaces, neon accents, mono labels, and soft bloom/aurora motion.

## Tokens

### Core Colors

- `--bg`: `#0a0b10`
- `--bg-raised`: `#14161e`
- `--bg-glass`: `rgba(20, 22, 31, 0.62)`
- `--border`: `#232838`
- `--text`: `#eef0f6`
- `--text-dim`: `#9aa0b2`
- `--accent`: `#7c9fff`
- `--accent-strong`: `#a7c0ff`
- `--cyan`: `#38e8ff`
- `--violet`: `#b98bff`
- `--gold`: `#ffd76a`
- `--brand-grad`: `linear-gradient(120deg, #b98bff 0%, #38e8ff 50%, #ffd76a 100%)`

### Typography

- Sans stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
- Mono stack: `SFMono-Regular, ui-monospace, Menlo, Consolas, 'Liberation Mono', monospace`
- Body copy uses the sans stack.
- Labels, pills, metadata, and utility UI use the mono stack.

### Layout And Shape

- Global `box-sizing: border-box`
- Rounded cards and pills are the default.
- Primary radii: 8px, 10px, 12px, 14px, 16px, 18px, 22px, and `999px` for pills.
- Surfaces use subtle borders and translucent backgrounds instead of flat fills.

## Spacing

Spacing is loose at desktop scale and tightens deliberately on smaller screens.

- Base outer padding is typically `1.5rem`.
- The nav uses `1.4rem 1.5rem 0` and `gap: 0.75rem`.
- Hero spacing uses `2.6rem 1.5rem 1rem` with `gap: 2.4rem`.
- CTA rows use `gap: 0.75rem`; pipeline chips use `gap: 0.55rem`.
- Gallery spacing uses `3.5rem 1.5rem 1rem`; grid cards use `gap: 1.4rem`.
- Card body spacing is `1rem 1.1rem 1.2rem` with `gap: 0.55rem`.
- Demo panel spacing uses `top: max(1rem, env(safe-area-inset-top))`, `left: max(1rem, env(safe-area-inset-left))`, width `min(320px, calc(100vw - 2rem))`, and inner padding `0.9rem 0.85rem 1rem`.
- Footer spacing is `3.5rem auto 0` with `1.5rem` padding.

Responsive spacing shifts:

- At `1024px` and below, outer left/right padding drops to `1.15rem` and hero gap tightens to `1.8rem`.
- At `860px` and below, hero gap tightens to `1.5rem`, hero top padding becomes `1.9rem`, and gallery top padding becomes `2.6rem`.
- At `640px` and below, nav padding becomes `1rem 0.95rem 0`, hero padding becomes `1.5rem 0.95rem 0.5rem`, CTA gap becomes `0.55rem`, gallery padding becomes `2.3rem 0.95rem 0.5rem`, grid gap becomes `1rem`, and card body padding becomes `0.85rem 0.9rem 1rem`.
- At `860px` with min-height above `520px`, the demo panel becomes a bottom sheet with full-width layout and `0.9rem 0.95rem 1.4rem` inner padding.
- At `max-height: 520px`, the demo panel stays a side column and keeps a reduced body height instead of using the sheet layout.

## Surfaces

- Background is a deep neutral base with fixed aurora gradients.
- Raised surfaces use `--bg-raised` or `--bg-glass`.
- Borders use `--border` unless a component is actively highlighted.
- Shadows are soft, layered, and glow-tinted rather than hard black-only shadows.

## Motion

The motion language is light and continuous, not bouncy:

- Aurora drift: 22s alternate
- Brand mark float: 6s infinite
- Accent pulse: 2s infinite
- Gradient shift: 7s infinite
- Card entry: 0.6s
- Demo panel transitions: 0.22s to 0.34s
- Hover lifts are small and transform-led; `transform` is GPU-friendly, while `box-shadow` and border transitions may still trigger paint work.

## Responsive Behavior

Breakpoints and compact rules are part of the design system:

- `1024px`: reduce outer padding
- `860px`: hero becomes single-column and the 3D stage moves first
- `640px`: tighter nav, hero, gallery, and card spacing
- `400px`: long nav labels are hidden
- `520px` max-height: demo panel becomes a side column instead of a sheet

## Demo Panel Contract

The demo panel is a core interaction pattern, not an optional overlay:

- Desktop: collapsible floating card at the top-left
- Phone portrait: bottom sheet with a grab handle and safe-area padding
- Short windows: keep it as a side column
- The panel body scrolls only when expanded
- The canvas owns gestures; the page should not fight orbit controls
- The hint text swaps between pointer and touch wording

## Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- Aurora, brand mark, gradient text, primary CTA gradient, eyebrow pulse, and stage beam animations stop
- Hero-copy, hero-stage, and card transitions/animations stop
- Demo-panel body, panel toggle chevron, and hint transitions stop
- Hero content and cards become immediately visible

## Component Set

Observed UI primitives in the stylesheet:

- Nav brand row, star pill, donate pill
- Hero eyebrow, title, subtitle, CTA row, pipeline chips
- Hero stage with canvas, photo thumb, beam, badge, hint
- Gallery grid, cards, status pills, badges
- Demo panel, toggle button, reference preview, metadata, links, part inspector

## Change Rule

If a visual token or breakpoint changes in `src/styles.css`, update this document in the same change.
