import * as THREE from 'three';

/**
 * The character's palette, MEASURED from the shell's own baked vertex colour — not picked by eye
 * off the reference photograph.
 *
 * Every number below came out of `tools/paletteProbe.ts` and `tools/hueProbe.ts` run against
 * `surfaceData.high.ts`. Crossing hue with height is what separates regions that either signal
 * alone confuses: warm-and-bright at crown height is skin, warm-and-dark at boot height is a red
 * boot; achromatic at crown height is hair, achromatic at ankle height is a shadowed sole.
 *
 * A note on brightness. The bake carries the lighting it was rendered under, so measured albedo is
 * far darker than the reference reads (crimson lands near #451c17, not #a8232b). The HUE is
 * trustworthy; the luminance is not. So the emissive colours the VFX and lights use keep the
 * measured hue and lift value/saturation to an emission-usable level — derived, and said out loud,
 * rather than quietly hand-picked.
 */

export type RegionId = 'skin' | 'hair' | 'lacquer-crimson' | 'cloth-indigo' | 'filigree-gold';

/** Costume regions — everything that is worn rather than grown. */
export const COSTUME_REGIONS: readonly RegionId[] = ['lacquer-crimson', 'cloth-indigo', 'filigree-gold'];
export const BODY_REGIONS: readonly RegionId[] = ['skin', 'hair'];

export interface RegionDefinition {
  id: RegionId;
  label: string;
  /** Measured cluster centre, sRGB hex, straight from the bake. */
  measuredHex: string;
  /** Measured hue in degrees; the signal the bake preserves faithfully. */
  measuredHue: number;
  /** Share of shell vertices this region claimed when the classifier last ran. */
  measuredShare: number;
  /**
   * Triangles this region owns after the split.
   *
   * A constant because the partition is deterministic — same data, same classifier, same result
   * every run — and the demo panel needs the number before the geometry has finished loading.
   * `tools/characterGate.ts` re-measures the real split and asserts the five sum to 294,240.
   */
  measuredTriangles: number;
  /** Emission colour: measured hue, value lifted so it reads as light rather than as paint. */
  emissive: number;
  material: {
    metalness: number;
    roughness: number;
    /** Lifts the dark bake back to a plausible albedo without inventing a new hue. */
    albedoGain: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    sheen?: number;
    sheenColor?: number;
  };
}

/**
 * Material scalars are read off the reference's finishes: lacquered plate over leather (crimson),
 * matte dyed cloth (indigo), polished cast metal (gold), skin, and hair.
 */
export const REGIONS: Record<RegionId, RegionDefinition> = {
  skin: {
    id: 'skin',
    label: 'skin',
    measuredHex: '#bf977e',
    measuredHue: 22,
    measuredShare: 0.056,
    measuredTriangles: 19977,
    emissive: 0x2a1410,
    material: { metalness: 0.0, roughness: 0.62, albedoGain: 1.25 },
  },
  hair: {
    id: 'hair',
    label: 'hair',
    measuredHex: '#13090e',
    measuredHue: 0,
    measuredShare: 0.144,
    measuredTriangles: 50625,
    emissive: 0x120a18,
    // Hair reads as anisotropic sheen, not as a rough dielectric; sheen is what gives the sweep.
    material: { metalness: 0.0, roughness: 0.34, albedoGain: 1.6, sheen: 0.9, sheenColor: 0x6b5a86 },
  },
  'lacquer-crimson': {
    id: 'lacquer-crimson',
    label: 'crimson lacquer',
    measuredHex: '#5f2d21',
    measuredHue: 9,
    measuredShare: 0.29,
    measuredTriangles: 104689,
    emissive: 0xff2a33,
    // Lacquer over leather: a clearcoat lobe on top of a fairly rough base.
    material: { metalness: 0.08, roughness: 0.42, albedoGain: 1.5, clearcoat: 0.65, clearcoatRoughness: 0.28 },
  },
  'cloth-indigo': {
    id: 'cloth-indigo',
    label: 'indigo cloth and plate',
    measuredHex: '#13182a',
    measuredHue: 226,
    measuredShare: 0.20,
    measuredTriangles: 59067,
    emissive: 0x4468ff,
    material: { metalness: 0.15, roughness: 0.68, albedoGain: 1.7, sheen: 0.35, sheenColor: 0x3a4d8f },
  },
  'filigree-gold': {
    id: 'filigree-gold',
    label: 'gold filigree',
    measuredHex: '#ab8c55',
    measuredHue: 41,
    measuredShare: 0.21,
    measuredTriangles: 59882,
    emissive: 0xffc247,
    material: { metalness: 0.92, roughness: 0.29, albedoGain: 1.35 },
  },
};

/**
 * The three colours every effect and every light in this showcase is allowed to use, so the VFX
 * reads as belonging to this character rather than as generic engine sparkle.
 */
export const SIGNATURE = {
  /** Crimson lacquer — the dominant costume colour, and the attack colour. */
  crimson: new THREE.Color(0xff2a33),
  /** Gold filigree — the dragon-and-cloud ornament; the accent and the rim. */
  gold: new THREE.Color(0xffc247),
  /** Indigo plate and cloth — the cool counterweight, and the fill light. */
  indigo: new THREE.Color(0x4468ff),
} as const;

/**
 * The colours offered for recolouring a piece of the outfit.
 *
 * `null` is first and means "as measured" — the colour actually read off the reference. It is kept
 * at the head of the list so the measured original is never more than one click away, and so a
 * visitor can always tell the reconstruction apart from their own recolour.
 *
 * The rest are dye colours a lacquered-plate armour of this period plausibly took, plus the two
 * neutrals that read well against gold. They are suggestions, not measurements, and the panel also
 * offers a free colour picker.
 */
export const OUTFIT_SWATCHES: readonly { id: string; label: string; hex: string | null }[] = [
  { id: 'measured', label: 'As measured', hex: null },
  { id: 'crimson', label: 'Crimson', hex: '#a8232b' },
  { id: 'indigo', label: 'Indigo', hex: '#2e3557' },
  { id: 'gold', label: 'Gold', hex: '#c9a227' },
  { id: 'jade', label: 'Jade', hex: '#2f7d5e' },
  { id: 'ivory', label: 'Ivory', hex: '#e8e0cf' },
  { id: 'obsidian', label: 'Obsidian', hex: '#1c1c24' },
  { id: 'plum', label: 'Plum', hex: '#6b2a4e' },
  { id: 'steel', label: 'Steel', hex: '#6d7784' },
];
