/**
 * Roblin's colour palette — MEASURED, then derived.
 *
 * Nothing here is an art-direction guess. Two independent measurements feed it:
 *
 *   1. REFERENCE PHOTO (showcase/reference.jpg, downsampled to 512x512, sRGB).
 *      A green-dominant mask (g > r + 4 and g > b + 18 and g > 40) selected 3,878 of 262,144
 *      pixels — the exposed skin. Median #697042 (hsl 69.1, 26%, 35%), p90 #91995e
 *      (hsl 68.1, 24%, 48%), p99 #aaaf75. Leather and hardware were point-sampled from the
 *      strap, belt, bracer and greave.
 *
 *   2. THE MODEL'S OWN VERTEX COLOURS (src/surfaceData.high.ts, 62,956 vertices, k-means k=6,
 *      deterministic seed). Shares: #342816 29.3%, #463922 24.9%, #59572a 18.0%, #6d673b 12.8%,
 *      #181106 10.5%, #807e77 4.4%. The 4.4% near-neutral cluster is the steel hardware; the
 *      12.8% cluster sits at mean height fraction 0.73 (head and shoulders) and is lit skin.
 *
 * The two agree on the important thing: Roblin is yellow-green (hue 47-69 degrees), not the
 * pure green a reader might assume from the word "goblin". Every emissive colour below keeps a
 * measured hue and moves only saturation and lightness, EXCEPT `steel`, which is flagged.
 *
 * Emissive colours cannot be measured off a diffuse photo — a photo has no emitters in it. What
 * is measured is the HUE; the saturation and lightness boosts are authored, and each one records
 * the boost it applied so the derivation stays auditable.
 */

export interface MeasuredSwatch {
  id: string;
  hex: string;
  /** Where the number came from — never "chosen". */
  source: string;
  /** hue degrees, saturation 0..1, lightness 0..1 — derived from `hex`, not stored separately. */
  hsl: [number, number, number];
}

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [((h * 60) % 360 + 360) % 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

function swatch(id: string, hex: string, source: string): MeasuredSwatch {
  return { id, hex, source, hsl: hexToHsl(hex) };
}

/** Straight from the two measurements. Do not edit by eye — re-measure and replace. */
export const MEASURED = {
  skinLit: swatch('skin-lit', '#91995e', 'reference.jpg, p90 of the 3,878-pixel green-dominant skin mask'),
  skinMid: swatch('skin-mid', '#697042', 'reference.jpg, median of the green-dominant skin mask'),
  skinShadow: swatch('skin-shadow', '#59572a', 'surfaceData.high vertex colours, cluster 3 of 6 (18.0% of vertices)'),
  leatherLit: swatch('leather-lit', '#6e6354', 'reference.jpg, point sample on the chest strap'),
  leatherMid: swatch('leather-mid', '#463922', 'surfaceData.high vertex colours, cluster 2 of 6 (24.9% of vertices)'),
  leatherShadow: swatch('leather-shadow', '#342816', 'surfaceData.high vertex colours, cluster 1 of 6 (29.3% of vertices)'),
  steel: swatch('steel', '#807e77', 'surfaceData.high vertex colours, cluster 6 of 6 (4.4% of vertices) — the bracers and greaves'),
  crevice: swatch('crevice', '#181106', 'surfaceData.high vertex colours, cluster 5 of 6 (10.5% of vertices)'),
} as const;

export interface DerivedColour {
  id: string;
  hex: string;
  /** 0xRRGGBB, ready for `new THREE.Color(value)`. */
  value: number;
  from: string;
  /** Exactly what was changed to get here, so a reviewer can undo it. */
  derivation: string;
}

function boost(
  id: string,
  base: MeasuredSwatch,
  saturation: number,
  lightness: number,
  hueShift = 0,
  note = '',
): DerivedColour {
  const [h, s, l] = base.hsl;
  const hex = hslToHex(h + hueShift, saturation, lightness);
  const shift = hueShift === 0 ? 'hue held' : `hue ${h.toFixed(1)} -> ${(h + hueShift).toFixed(1)}`;
  return {
    id,
    hex,
    value: parseInt(hex.slice(1), 16),
    from: `${base.id} ${base.hex} (${base.source})`,
    derivation: `${shift}, saturation ${(s * 100).toFixed(0)}% -> ${(saturation * 100).toFixed(0)}%, `
      + `lightness ${(l * 100).toFixed(0)}% -> ${(lightness * 100).toFixed(0)}%${note ? `. ${note}` : ''}`,
  };
}

/**
 * The emissive set every effect and every light draws from.
 *
 * `toxic` is the signature: Roblin's own skin hue, saturated until it can carry an emissive.
 * `ember` is the leather hue, the warm counterweight that keeps a green-on-green scene readable.
 * `steel` is the one honest exception — see its `derivation`.
 */
export const VFX = {
  toxic: boost('toxic', MEASURED.skinLit, 0.95, 0.56, 4,
    'the 4-degree push is toward green so the emissive does not read as plain yellow at bloom threshold'),
  venom: boost('venom', MEASURED.skinMid, 0.9, 0.3),
  spore: boost('spore', MEASURED.skinLit, 0.75, 0.78),
  ember: boost('ember', MEASURED.leatherLit, 0.92, 0.55, -4),
  emberDeep: boost('ember-deep', MEASURED.leatherShadow, 0.95, 0.36),
  steel: {
    id: 'steel',
    hex: '#cfe4ee',
    value: 0xcfe4ee,
    from: `steel ${MEASURED.steel.hex} (${MEASURED.steel.source})`,
    derivation: 'AUTHORED HUE, not measured. The hardware measures 4% saturation at hue ~50, which '
      + 'carries no usable hue at all; a boost of a near-neutral swatch produces whatever hue the '
      + 'sampling noise happened to leave. Shifted to a cool 200 on purpose so metal sparks separate '
      + 'from the toxic green. This is the only colour in the file that is not hue-faithful.',
  } as DerivedColour,
  /** Shadow side of the figure, used for the ground bounce so the floor is not neutral grey. */
  bounce: boost('bounce', MEASURED.crevice, 0.55, 0.16),
} as const;

export type VfxColourId = keyof typeof VFX;

/** One line per colour — printed to the console at boot so the derivation is never invisible. */
export function paletteReport(): string[] {
  return Object.values(VFX).map((c) => `${c.id.padEnd(11)} ${c.hex}  <- ${c.from}\n${' '.repeat(13)}${c.derivation}`);
}
