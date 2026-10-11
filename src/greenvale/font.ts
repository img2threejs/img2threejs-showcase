/**
 * Greenvale gameplay font loader.
 *
 * Source: Be Vietnam Pro (https://github.com/bettergui/BeVietnamPro),
 * licensed under the SIL Open Font License v1.1 (see OFL.txt).
 * WOFF2 subsets (vietnamese / latin-ext / latin) for weights 400/500/600/700
 * are bundled locally at /greenvale/fonts/.
 *
 * Registers FontFace objects with explicit `unicodeRange` per face so
 * the browser maps characters to the right subset. No silent system
 * fallback: loadGameFont either resolves once every face is registered
 * and a sample renders, or rejects with a descriptive error.
 */

const FONT_FAMILY = 'Be Vietnam Pro';
type Subset = 'vi' | 'ext' | 'lat';
const SUBSETS: readonly Subset[] = ['vi', 'ext', 'lat'];
const WEIGHTS = [400, 500, 600, 700] as const;
const BASE = import.meta.env.BASE_URL;

/**
 * Unicode-range per (subset, weight). Mirrors the values Google Fonts
 * ships for the downloaded woff2 faces. When a `FontFace` declares a
 * `unicodeRange`, the browser only selects it for matching characters
 * — without this all 12 faces would overlap and the active face would
 * be implementation-defined (last-loaded wins on most engines).
 */
const UNICODE_RANGE: Record<Subset, string> = {
  vi: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
  ext: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
  lat: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
};

const subsetUrl = (weight: number, subset: Subset): string =>
  `${BASE}greenvale/fonts/be-vietnam-pro-${weight}-${subset}.woff2`;

/**
 * Glyphs the HUD actively renders. Vietnamese glyphs cover the diacritic set
 * the HUD copy uses; Latin glyphs cover numbers and the English hotkeys.
 *
 * Sampling these with `document.fonts.load(shorthand, sample)` proves the
 * browser reached the right subset — but it does NOT prove the full cmap
 * covers every codepoint in those ranges; that claim is supported by the
 * upstream Google Fonts CSS declaring matching unicode-ranges.
 */
const REQUIRED_VI = 'ĂÂĐÊÔƠƯăâđêôơưáàảãạằẳẵặắẩẫậếễểệốổỗộớờởỡợứừửữựýỳỷỹỵ';
const REQUIRED_LAT = '0123456789/:Lv. MAPGreenvaleHerbsQuestSkillsHealFireIceManaHPInventoryShortcut';

interface DocumentWithFonts extends Document { fonts: FontFaceSet }

function getFontSet(): FontFaceSet | null {
  if (typeof document === 'undefined') return null;
  return (document as Document & { fonts?: FontFaceSet }).fonts ?? null;
}

/** Builds the CSS font shorthand: `weight size "family"`. */
function fontShorthand(weight: number): string {
  return `${weight} 16px "${FONT_FAMILY}"`;
}

async function registerFace(weight: number, subset: Subset): Promise<FontFace> {
  const url = subsetUrl(weight, subset);
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Unable to load font ${url}: HTTP ${response.status}`);
  // NOTE: do not slice to Content-Length. HTTP Content-Length reports the
  // compressed wire length, while the FontFace constructor needs the raw
  // woff2 bytes; slicing to the compressed length corrupts the font file.
  const buffer = await response.arrayBuffer();
  const face = new FontFace(FONT_FAMILY, buffer, {
    style: 'normal',
    weight: `${weight}`,
    stretch: 'normal',
    display: 'swap',
    unicodeRange: UNICODE_RANGE[subset],
  });
  const loaded = await face.load();
  const registered = loaded as FontFace;
  (document as DocumentWithFonts).fonts.add(registered);
  return registered;
}

async function proveSamplesRender(family: string): Promise<void> {
  const fonts = getFontSet();
  if (!fonts) throw new Error('Document.fonts is unavailable; the game font cannot be verified.');
  // First arg is the CSS font shorthand — `weight size "family"`.
  // Second arg is the actual sample text the browser should be able to shape.
  await fonts.load(`${fontShorthand(400)}, "${family}"`, `${REQUIRED_VI} ${REQUIRED_LAT}`);
  // We do NOT claim `check(glyph, family)` proves full cmap coverage —
  // the unicode-range declarations above are what the browser uses to pick
  // faces per character. We just confirm a representative sample resolves.
  if (!fonts.check(`${fontShorthand(400)}, "${family}"`, REQUIRED_VI)) {
    throw new Error('The browser could not render the Vietnamese glyph sample for Be Vietnam Pro.');
  }
  if (!fonts.check(`${fontShorthand(400)}, "${family}"`, REQUIRED_LAT)) {
    throw new Error('The browser could not render the Latin glyph sample for Be Vietnam Pro.');
  }
}

let loading: Promise<void> | null = null;
let settled = false;

/**
 * Loads the bundled Be Vietnam Pro family (weights 400/500/600/700 across
 * the Vietnamese / Latin-Ext / Latin subsets), then proves the browser can
 * shape both Vietnamese and Latin samples of the rendered text.
 *
 * Safe to call multiple times: subsequent calls share the same promise.
 * No try/catch swallowing — rejects with a typed Error on every failure.
 */
export async function loadGameFont(): Promise<void> {
  const fonts = getFontSet();
  if (!fonts || typeof window === 'undefined' || !('FontFace' in window)) {
    throw new Error('This browser does not support the FontFace API required by the Be Vietnam Pro HUD font.');
  }
  if (settled) return;
  if (loading) return loading;
  loading = (async () => {
    await Promise.all(
      WEIGHTS.flatMap((weight) => SUBSETS.map((subset) => registerFace(weight, subset))),
    );
    await proveSamplesRender(FONT_FAMILY);
    settled = true;
  })();
  try {
    await loading;
  } catch (error) {
    loading = null;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export const GAME_FONT_FAMILY = FONT_FAMILY;
export const GAME_FONT_SUBSETS: readonly Subset[] = SUBSETS;
export const GAME_FONT_WEIGHTS: readonly number[] = WEIGHTS;

export function isGameFontReady(): boolean {
  return settled;
}
