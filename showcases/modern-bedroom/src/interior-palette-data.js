// Room colour customisation: the authored groups, curated swatches and themed presets.
//
// Pure data, no imports, no side effects. `src/interior-palette.js` (engine) and `src/interior-palette-ui.js` (panel) consume it;
// `tests/test_palette_data.mjs` verifies it against the runtime GLB and the textures it ships.
//
// MATCHING. A runtime mesh belongs to a group when its material's base name (the part before `__atlas`) is listed in
// `materials` AND (`meshes` is empty OR the mesh's `physical_id` / node name matches one of the globs). `*` matches one
// dot-separated segment, `**` any number of segments (`bed.frame.**` = `bed.frame.deck`, `bed.frame.side.-1.005`).
// Every (material, mesh) pair is owned by at most one group (tests enforce it). Exterior city, glass, bulb shells, book
// pages and the three abstract-art accents are intentionally unowned: they keep their authored look.
//
// DEFAULTS. `default` of a `recolor` group is the authored mean albedo in sRGB: the mean of the base-colour texture in
// LINEAR light (that is what the shader multiplies) times baseColorFactor, re-encoded to sRGB. Every material of a group
// has the same mean (tests measure it from the GLB-embedded textures). A recolour maps this mean to the chosen colour and
// keeps the texture's relative luminance detail (grain, weave, knit).
//
// FINISH. `finish` is a roughness range for the matte <-> satin slider; `finish.default` is the authored MEAN roughness of
// the material (mean of the roughness texture's green channel times roughnessFactor). The engine scales the roughness
// texture so that its mean lands on the chosen value.
//
// LIGHT. The `pendant-light` group is `kind: 'light'`. Its `default` is the authored spot colour (sRGB of the manifest's
// linear `lighting.pendants[].color`) and `kelvin.default` is the colour temperature that reproduces it: at that
// temperature the authored colour must be reproduced exactly; other temperatures scale it by
// blackbody(kelvin) / blackbody(kelvin.default) per channel. Light groups are NOT part of preset `colors`; a preset
// drives them through `kelvin` only. Light swatches carry an extra `kelvin` field (their hex is the blackbody sRGB).

export const PALETTE_VERSION = 1;

const MATTE_WALL = { min: 0.7, max: 1.0 };
const WOOD_RANGE = { min: 0.3, max: 0.9 };
const FABRIC_RANGE = { min: 0.85, max: 1.0 };
const METAL_RANGE = { min: 0.2, max: 0.8 };
const STONE_RANGE = { min: 0.3, max: 0.9 };
const GLAZE_RANGE = { min: 0.2, max: 0.9 };

const finish = (range, authored) => ({ ...range, default: authored });
const swatches = list => list.map(([label, hex]) => ({ label, hex }));

// ---- Swatch libraries ---------------------------------------------------------------------------------------------

const PAINT = swatches([
  ['Chalk White', '#f2efe8'], ['Wimborne White', '#ebe4d4'], ['Skimming Stone', '#d6cab5'], ['Greige', '#bdb2a3'],
  ['Mushroom', '#a59a8c'], ['Powder Blue', '#b9c9d3'], ['Sage Leaf', '#a9b49b'], ['Eucalyptus', '#8d9f8f'],
  ['Setting Plaster', '#e2b9a6'], ['Warm Ochre', '#c8a05a'], ['Terracotta', '#b4624a'], ['Green Smoke', '#5d6b5b'],
  ['Midnight Navy', '#232f45'], ['Charcoal', '#3b3d3f'],
]);

const PAINT_ACCENT = swatches([
  ['Wimborne White', '#ebe4d4'], ['Greige', '#bdb2a3'], ['Powder Blue', '#b9c9d3'], ['Sage Leaf', '#a9b49b'],
  ['Eucalyptus', '#8d9f8f'], ['Setting Plaster', '#e2b9a6'], ['Warm Ochre', '#c8a05a'], ['Terracotta', '#b4624a'],
  ['Deep Teal', '#24484a'], ['Green Smoke', '#5d6b5b'], ['Midnight Navy', '#232f45'], ['Oxblood', '#5b2c2c'],
  ['Aubergine', '#46303f'], ['Charcoal', '#3b3d3f'],
]);

const CEILING = swatches([
  ['Pure White', '#f7f5f0'], ['Wimborne White', '#ebe4d4'], ['Ivory Cream', '#efe6cf'],
  ['Pale Stone', '#dcd4c4'], ['Light Grey', '#d3d3d0'], ['Pale Blue Wash', '#dfe6ea'], ['Pale Sage', '#d7ddcf'],
  ['Soft Blush', '#f0dcd3'], ['Greige', '#bdb2a3'], ['Midnight Navy', '#232f45'],
]);

const FLOOR = swatches([
  ['Bleached Oak', '#d9c9ab'], ['White Oak', '#cdb48d'], ['Natural Oak', '#b99a6b'], ['Honey Ash', '#c6a477'],
  ['Grey-Washed Ash', '#a7a39a'], ['Weathered Grey', '#8a8780'], ['Teak', '#9a6b3d'], ['Cherry', '#8d4b32'],
  ['Smoked Oak', '#6b5846'], ['Mahogany', '#5e2f22'], ['Fumed Oak', '#4f4234'], ['Ebonised', '#2e2723'],
]);

const WOOD = swatches([
  ['Maple', '#d8b988'], ['White Oak', '#cdb48d'], ['Natural Oak', '#b99a6b'], ['Teak', '#9a6b3d'],
  ['Cherry', '#8d4b32'], ['Grey-Washed Ash', '#a7a39a'], ['Smoked Oak', '#6b5846'], ['Walnut', '#5f4638'],
  ['Mahogany', '#5e2f22'], ['Dark Walnut', '#3d2a1f'], ['Ebonised', '#2e2723'], ['Whitewashed Ash', '#e3dccd'],
]);

const FRAME = swatches([
  ['Black Lacquer', '#1d1b1a'], ['Ebonised Oak', '#2e2723'], ['Walnut', '#5f4638'], ['Teak', '#9a6b3d'],
  ['Natural Oak', '#b99a6b'], ['Maple', '#d8b988'], ['Aged Brass', '#a68a52'], ['Gilt Gold', '#c3a15f'],
  ['Antique Silver', '#a8a8a2'], ['Gallery White', '#e8e4dc'], ['Sage Lacquer', '#8d9f8f'], ['Navy Lacquer', '#26324a'],
]);

const UPHOLSTERY = swatches([
  ['Oatmeal', '#cfc4b0'], ['Mushroom', '#a89a8a'], ['Dove Grey', '#9d9c98'], ['Charcoal Flannel', '#4a4c4e'],
  ['Dusty Blue', '#8fa3b4'], ['Slate Blue', '#66788c'], ['Petrol Teal', '#3e5f66'], ['Midnight Navy', '#26324a'],
  ['Sage', '#9aa88f'], ['Forest Green', '#3f5b47'], ['Blush Pink', '#d4aaa0'], ['Terracotta', '#b0634b'],
  ['Mustard', '#c2993f'], ['Burgundy', '#6a2e38'],
]);

const LINEN = swatches([
  ['White Linen', '#efede6'], ['Ivory', '#e8e1d1'], ['Natural Flax', '#d3c8b0'], ['Oatmeal', '#cdbfa8'],
  ['Stone Wash', '#b4aca0'], ['Dove Grey', '#9d9c98'], ['Charcoal', '#55575a'], ['Sage', '#a2ae98'],
  ['Olive', '#747a56'], ['Dusty Blue', '#8ea1b0'], ['Navy', '#2f3e57'], ['Blush', '#dbb8ad'],
  ['Terracotta', '#b4694f'], ['Mustard', '#c9a04a'],
]);

const SHEET = swatches([
  ['Percale White', '#f0ede6'], ['Ecru', '#e0d5c0'], ['Champagne', '#d9c6a8'], ['Sand', '#cdbb9f'],
  ['Taupe', '#a89888'], ['Mist Blue', '#b8c6cf'], ['Sage', '#a2ae98'], ['Blush', '#dbb8ad'],
  ['Slate', '#7d8790'], ['Terracotta Clay', '#b4694f'], ['Charcoal', '#55575a'], ['Navy', '#2f3e57'],
]);

const KNIT = swatches([
  ['Cream Aran', '#e2dccb'], ['Oatmeal', '#c8baa2'], ['Camel', '#b58a5a'], ['Heather Grey', '#9a9a9c'],
  ['Charcoal Wool', '#4a4b4d'], ['Blush', '#d2a79c'], ['Mustard', '#c79a3d'], ['Rust', '#a4523a'],
  ['Moss', '#6b7048'], ['Forest', '#3d5440'], ['Petrol', '#36565c'], ['Denim', '#4d6683'],
  ['Burgundy', '#6e2f3a'], ['Ink', '#263040'],
]);

const RUG = swatches([
  ['Ivory Wool', '#e0d9c9'], ['Oatmeal', '#c9bba3'], ['Sand', '#cdb894'], ['Stone', '#a8a398'],
  ['Dove', '#9c9a96'], ['Charcoal', '#4d4e50'], ['Black', '#26262a'], ['Sage', '#929f88'],
  ['Teal', '#3e6663'], ['Indigo', '#34425d'], ['Blush', '#d7b3a6'], ['Camel', '#b58d5c'],
  ['Terracotta', '#b0634a'], ['Rust', '#8f4a33'],
]);

const DRAPE = swatches([
  ['Ivory', '#d9d2c3'], ['Greige', '#a89d90'], ['Warm Grey', '#8f8b86'], ['Taupe', '#7c7066'],
  ['Charcoal', '#4b4a49'], ['Black', '#24231f'], ['Sage', '#8a9680'], ['Dusty Blue', '#7c8fa0'],
  ['Navy Velvet', '#2c3a55'], ['Forest', '#46614b'], ['Blush', '#c8a49a'], ['Terracotta', '#a85b44'],
  ['Mustard', '#b58f3a'], ['Burgundy', '#5b2a33'],
]);

const SHEER = swatches([
  ['White Voile', '#f4f2ec'], ['Ivory', '#ebe6d6'], ['Champagne', '#e3d7bf'], ['Sand', '#d8c9ae'],
  ['Light Taupe', '#cbbfb0'], ['Soft Grey', '#d6d5d1'], ['Smoke', '#b9b8b4'], ['Pale Blush', '#eed9d0'],
  ['Pale Sage', '#dbe0d2'], ['Mist Blue', '#d3dde4'], ['Pale Gold', '#e8d9a8'],
]);

const METAL = swatches([
  ['Matte Black', '#232323'], ['Graphite', '#3a3b3d'], ['Gunmetal', '#4d5156'], ['Pewter', '#7a7a7a'],
  ['Brushed Nickel', '#a3a39f'], ['Satin Chrome', '#c4c6c8'], ['Bronze', '#6b5436'], ['Antique Brass', '#8a6d3b'],
  ['Brushed Brass', '#b89b5a'], ['Champagne Gold', '#c6ac80'], ['Copper', '#a9633d'], ['Powder White', '#e6e4de'],
  ['Forest Green', '#2f3d34'], ['Navy', '#1f2a3a'],
]);

const LAMP = swatches([
  ['Matte Black', '#232323'], ['Graphite', '#3a3b3d'], ['Bronze', '#6b5436'], ['Antique Brass', '#8a6d3b'],
  ['Brushed Brass', '#b89b5a'], ['Copper', '#a9633d'], ['Brushed Nickel', '#a3a39f'], ['Opal White', '#e8e4d8'],
  ['Terracotta Enamel', '#b0583c'], ['Sage Enamel', '#8d9f8f'], ['Cobalt Enamel', '#2f4a85'], ['Forest Green', '#2f3d34'],
]);

const STONE = swatches([
  ['Ivory Travertine', '#d8cdb4'], ['Silver Travertine', '#b9b3a6'], ['Noce Travertine', '#a98f70'], ['Limestone', '#cfc9b8'],
  ['Carrara Marble', '#e9e8e4'], ['Calacatta Oro', '#ece5d6'], ['Sandstone', '#c4a882'], ['Pink Onyx', '#d8b8a8'],
  ['Terrazzo Grey', '#a5a39f'], ['Verde Alpi', '#3d5446'], ['Slate', '#5a5d60'], ['Nero Marquina', '#25252a'],
]);

const GLAZE = swatches([
  ['Bone', '#e4dccb'], ['Sand Glaze', '#c9b690'], ['Celadon', '#a9bfae'], ['Blush', '#d9b4a8'],
  ['Mustard', '#c19a2e'], ['Terracotta', '#b9684c'], ['Olive Glaze', '#6b6d42'], ['Slate Blue', '#5d7186'],
  ['Cobalt', '#2f4a85'], ['Oxblood', '#6b2b2a'], ['Charcoal', '#4b4a4a'], ['Matte Black', '#2b2a29'],
]);

const ARTWORK = swatches([
  ['Gallery White', '#e8e5dc'], ['Raw Canvas', '#cbbd9f'], ['Warm Grey', '#a8a192'], ['Sage', '#94a38a'],
  ['Slate', '#5f6a75'], ['Dusty Rose', '#cfa59c'], ['Ochre', '#c49a45'], ['Terracotta', '#b0624a'],
  ['Forest', '#3d5543'], ['Navy', '#2f3d57'], ['Ink Black', '#25262a'],
]);

// Blackbody colour temperature stops for the pendants (sRGB of the Tanner Helland blackbody approximation).
const LIGHT = [
  { label: 'Candlelight', hex: '#ff9227', kelvin: 2200 },
  { label: 'Filament glow', hex: '#ff9b3d', kelvin: 2400 },
  { label: 'Warm white (authored)', hex: '#ffa757', kelvin: 2700 },
  { label: 'Soft white', hex: '#ffb16e', kelvin: 3000 },
  { label: 'Halogen', hex: '#ffb87b', kelvin: 3200 },
  { label: 'Neutral warm', hex: '#ffc18d', kelvin: 3500 },
  { label: 'Cool white', hex: '#ffcea6', kelvin: 4000 },
  { label: 'Daylight bulb', hex: '#ffdabb', kelvin: 4500 },
];

// ---- Groups -------------------------------------------------------------------------------------------------------

export const PALETTE_GROUPS = [
  // surfaces ---------------------------------------------------------------------------------------------------------
  { id: 'walls', label: 'Walls', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Plaster'],
    meshes: ['shell.back', 'shell.left', 'shell.front.hidden', 'window.wall.return.**', 'window.wall.header', 'balcony.parapet'],
    default: '#dad3c3', swatches: PAINT, finish: finish(MATTE_WALL, 0.89) },
  { id: 'feature-wall', label: 'Feature wall & skirting', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Plaster'], meshes: ['wall.central.feature', 'wall.central.skirt'],
    default: '#dad3c3', swatches: PAINT_ACCENT, finish: finish(MATTE_WALL, 0.89) },
  { id: 'ceiling', label: 'Ceiling', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Plaster'], meshes: ['shell.ceiling'],
    default: '#dad3c3', swatches: CEILING, finish: finish(MATTE_WALL, 0.89) },
  { id: 'floor', label: 'Floor', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Floorwood'], meshes: [],
    default: '#745b51', swatches: FLOOR, finish: finish(WOOD_RANGE, 0.3) },
  { id: 'travertine', label: 'Nightstand tops & sill', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Stone'], meshes: ['nightstand.*.travertine', 'window.wall.threshold', 'balcony.slab'],
    default: '#cfc2ab', swatches: STONE, finish: finish(STONE_RANGE, 0.68) },
  { id: 'vase', label: 'Vase', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Ceramic'], meshes: [],
    default: '#b3a891', swatches: GLAZE, finish: finish(GLAZE_RANGE, 0.76) },
  { id: 'art-panel', label: 'Artwork panel & books', category: 'surfaces', kind: 'recolor',
    materials: ['Bedroom.Art'], meshes: [],
    default: '#a8a192', swatches: ARTWORK, finish: finish({ min: 0.7, max: 1.0 }, 0.94) },

  // wood -------------------------------------------------------------------------------------------------------------
  { id: 'wardrobe-left', label: 'Side wardrobe', category: 'wood', kind: 'recolor',
    materials: ['Bedroom.WalnutWarm'], meshes: [],
    default: '#8e6549', swatches: WOOD, finish: finish(WOOD_RANGE, 0.48) },
  { id: 'wardrobe-back', label: 'Back wardrobe & dresser', category: 'wood', kind: 'recolor',
    materials: ['Bedroom.WalnutDark'], meshes: [],
    default: '#452b1b', swatches: WOOD, finish: finish(WOOD_RANGE, 0.48) },
  { id: 'bed-frame', label: 'Bed frame', category: 'wood', kind: 'recolor',
    materials: ['Bedroom.Walnut'], meshes: ['bed.frame.**', 'bed.leg.**'],
    default: '#6e564a', swatches: WOOD, finish: finish(WOOD_RANGE, 0.48) },
  { id: 'nightstands', label: 'Nightstands', category: 'wood', kind: 'recolor',
    materials: ['Bedroom.Walnut'], meshes: ['nightstand.*.body', 'nightstand.*.drawer'],
    default: '#6e564a', swatches: WOOD, finish: finish(WOOD_RANGE, 0.48) },
  { id: 'art-frame', label: 'Art frame', category: 'wood', kind: 'recolor',
    materials: ['Bedroom.Walnut'], meshes: ['art.frame.**', 'art.abstract.fine-line'],
    default: '#6e564a', swatches: FRAME, finish: finish(WOOD_RANGE, 0.48) },

  // bed --------------------------------------------------------------------------------------------------------------
  { id: 'headboard', label: 'Headboard', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.Petrol'], meshes: [],
    default: '#7a8486', swatches: UPHOLSTERY, finish: finish(FABRIC_RANGE, 0.88) },
  { id: 'fitted-sheet', label: 'Fitted sheet', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.Sheet'], meshes: [],
    default: '#bea897', swatches: SHEET, finish: finish(FABRIC_RANGE, 0.9) },
  { id: 'duvet', label: 'Duvet', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.Linen'], meshes: ['bedding.duvet.**'],
    default: '#d3cfc7', swatches: LINEN, finish: finish(FABRIC_RANGE, 0.9) },
  { id: 'pillows-rear', label: 'Rear pillows', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.LinenRear'], meshes: [],
    default: '#d6d0c5', swatches: LINEN, finish: finish(FABRIC_RANGE, 0.9) },
  { id: 'pillows-front', label: 'Front pillows', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.Pillow'], meshes: [],
    default: '#a2a19c', swatches: LINEN, finish: finish(FABRIC_RANGE, 0.9) },
  { id: 'throw', label: 'Knitted throw', category: 'bed', kind: 'recolor',
    materials: ['Bedroom.Throw'], meshes: ['bedding.throw.**'],
    default: '#696a6b', swatches: KNIT, finish: finish(FABRIC_RANGE, 0.94) },

  // textiles ---------------------------------------------------------------------------------------------------------
  { id: 'rug', label: 'Rug', category: 'textiles', kind: 'recolor',
    materials: ['Bedroom.Rug'], meshes: [],
    default: '#98938a', swatches: RUG, finish: finish(FABRIC_RANGE, 0.96) },
  { id: 'drapes', label: 'Drapes', category: 'textiles', kind: 'recolor',
    materials: ['Bedroom.Drape'], meshes: [],
    default: '#8f8b86', swatches: DRAPE, finish: finish(FABRIC_RANGE, 0.9) },
  { id: 'sheers', label: 'Sheer curtains', category: 'textiles', kind: 'recolor',
    materials: ['Bedroom.Sheer'], meshes: [],
    default: '#ebe8de', swatches: SHEER, finish: finish(FABRIC_RANGE, 0.9) },

  // window -----------------------------------------------------------------------------------------------------------
  { id: 'window-frames', label: 'Window frames, rails & balcony rail', category: 'window', kind: 'recolor',
    materials: ['Bedroom.Metal'], meshes: [],
    default: '#646462', swatches: METAL, finish: finish(METAL_RANGE, 0.5) },

  // metal ------------------------------------------------------------------------------------------------------------
  { id: 'lamp-shells', label: 'Pendant shells & cables', category: 'metal', kind: 'recolor',
    materials: ['Bedroom.Metaldark'], meshes: ['pendant.*.canopy', 'pendant.*.sculpted-shell', 'pendant.*.cable'],
    default: '#46433e', swatches: LAMP, finish: finish(METAL_RANGE, 0.5) },
  { id: 'handles', label: 'Wardrobe handles', category: 'metal', kind: 'recolor',
    materials: ['Bedroom.Metaldark'], meshes: ['wardrobe.*.handle.*'],
    default: '#46433e', swatches: METAL, finish: finish(METAL_RANGE, 0.5) },

  // lighting ---------------------------------------------------------------------------------------------------------
  { id: 'pendant-light', label: 'Pendant light colour', category: 'lighting', kind: 'light',
    materials: ['Bedroom.PendantBulb'], meshes: [],
    default: '#ffd6a2', swatches: LIGHT, finish: null, kelvin: { min: 2200, max: 4500, default: 2700 } },
];

// ---- Presets ------------------------------------------------------------------------------------------------------
// `colors` covers every recolour group. `finishes` (optional) overrides roughness for the listed groups only; the others
// keep their authored finish. `kelvin` sets the pendant colour temperature. The `original` preset is the authored room.

const RECOLOR_GROUPS = PALETTE_GROUPS.filter(group => group.kind === 'recolor');
const LIGHT_GROUP = PALETTE_GROUPS.find(group => group.kind === 'light');

export const PALETTE_PRESETS = [
  { id: 'original', label: 'Original (reference)',
    description: 'The authored room exactly as exported: plaster, walnut, petrol headboard and warm 2700 K pendants.',
    colors: Object.fromEntries(RECOLOR_GROUPS.map(group => [group.id, group.default])),
    finishes: Object.fromEntries(RECOLOR_GROUPS.filter(group => group.finish).map(group => [group.id, group.finish.default])),
    kelvin: LIGHT_GROUP.kelvin.default },

  { id: 'scandinavian-light', label: 'Scandinavian Light',
    description: 'Bright white plaster, pale oak, grey-blue upholstery and a crisp neutral-warm glow.',
    colors: {
      'walls': '#f3f1ec', 'feature-wall': '#c5d0d4', 'ceiling': '#f7f5f0', 'floor': '#b99a6b', 'travertine': '#e9e8e4',
      'vase': '#e4dccb', 'art-panel': '#e8e5dc',
      'wardrobe-left': '#d8b988', 'wardrobe-back': '#b99a6b', 'bed-frame': '#d8b988', 'nightstands': '#d8b988', 'art-frame': '#e8e4dc',
      'headboard': '#8fa3b4', 'fitted-sheet': '#f0ede6', 'duvet': '#cdbfa8', 'pillows-rear': '#e8e1d1', 'pillows-front': '#9d9c98', 'throw': '#e2dccb',
      'rug': '#e0d9c9', 'drapes': '#a89d90', 'sheers': '#f4f2ec',
      'window-frames': '#e6e4de', 'lamp-shells': '#e8e4d8', 'handles': '#a3a39f',
    },
    finishes: { 'floor': 0.6, 'wardrobe-left': 0.62, 'wardrobe-back': 0.62, 'bed-frame': 0.62, 'nightstands': 0.62 },
    kelvin: 3000 },

  { id: 'japandi', label: 'Japandi',
    description: 'Warm putty walls, natural oak, charcoal accents and black hardware for a calm, grounded room.',
    colors: {
      'walls': '#d0c6b2', 'feature-wall': '#a59a8c', 'ceiling': '#ebe4d4', 'floor': '#b49670', 'travertine': '#b9b3a6',
      'vase': '#2b2a29', 'art-panel': '#cbbd9f',
      'wardrobe-left': '#b99a6b', 'wardrobe-back': '#4a3a2c', 'bed-frame': '#5f4638', 'nightstands': '#5f4638', 'art-frame': '#1d1b1a',
      'headboard': '#747a56', 'fitted-sheet': '#e0d5c0', 'duvet': '#f3efe6', 'pillows-rear': '#cdbfa8', 'pillows-front': '#4a4c4e', 'throw': '#6b7048',
      'rug': '#c9bba3', 'drapes': '#7c7066', 'sheers': '#ebe6d6',
      'window-frames': '#232323', 'lamp-shells': '#232323', 'handles': '#232323',
    },
    finishes: { 'floor': 0.7, 'wardrobe-left': 0.7, 'wardrobe-back': 0.65, 'bed-frame': 0.7, 'nightstands': 0.7 },
    kelvin: 2700 },

  { id: 'warm-minimal', label: 'Warm Minimal',
    description: 'Cream plaster, honey oak, camel linen and brushed brass under a low amber glow.',
    colors: {
      'walls': '#dcc9ae', 'feature-wall': '#b8946d', 'ceiling': '#f3ebdd', 'floor': '#a9825a', 'travertine': '#d8cdb4',
      'vase': '#c9b690', 'art-panel': '#cbbd9f',
      'wardrobe-left': '#b99a6b', 'wardrobe-back': '#7e5636', 'bed-frame': '#9a6b3d', 'nightstands': '#9a6b3d', 'art-frame': '#c3a15f',
      'headboard': '#7a6a5c', 'fitted-sheet': '#d9c6a8', 'duvet': '#f7f2e8', 'pillows-rear': '#e8e1d1', 'pillows-front': '#b58a5a', 'throw': '#c8a075',
      'rug': '#d9c9ad', 'drapes': '#9c8265', 'sheers': '#f0e6d6',
      'window-frames': '#8a6d3b', 'lamp-shells': '#b89b5a', 'handles': '#b89b5a',
    },
    finishes: { 'floor': 0.45, 'wardrobe-left': 0.5, 'bed-frame': 0.5, 'nightstands': 0.5, 'handles': 0.3, 'lamp-shells': 0.35 },
    kelvin: 2400 },

  { id: 'terracotta-sunset', label: 'Terracotta Sunset',
    description: 'Burnt-clay feature wall, plaster blush, teak and mustard accents with the warmest bulbs.',
    colors: {
      'walls': '#dcc3ad', 'feature-wall': '#b4624a', 'ceiling': '#f2e6d9', 'floor': '#8d5a3b', 'travertine': '#c4a882',
      'vase': '#6b2b2a', 'art-panel': '#c49a45',
      'wardrobe-left': '#9a6b3d', 'wardrobe-back': '#4a2a1d', 'bed-frame': '#5e2f22', 'nightstands': '#5e2f22', 'art-frame': '#2e2723',
      'headboard': '#8f4a33', 'fitted-sheet': '#e0d5c0', 'duvet': '#f7efe3', 'pillows-rear': '#d9c6a8', 'pillows-front': '#c9a04a', 'throw': '#a4523a',
      'rug': '#d7b3a6', 'drapes': '#a85b44', 'sheers': '#f0dcc8',
      'window-frames': '#3a3b3d', 'lamp-shells': '#a9633d', 'handles': '#a9633d',
    },
    finishes: { 'walls': 0.95, 'feature-wall': 0.95, 'floor': 0.4, 'handles': 0.35 },
    kelvin: 2200 },

  { id: 'sage-retreat', label: 'Sage Retreat',
    description: 'Soft sage walls and moss textiles on natural oak, with a gentle soft-white light.',
    colors: {
      'walls': '#c5cdb7', 'feature-wall': '#8d9f8f', 'ceiling': '#f2efe8', 'floor': '#b99a6b', 'travertine': '#cfc9b8',
      'vase': '#a9bfae', 'art-panel': '#94a38a',
      'wardrobe-left': '#cdb48d', 'wardrobe-back': '#6b5846', 'bed-frame': '#6b5846', 'nightstands': '#6b5846', 'art-frame': '#5f4638',
      'headboard': '#5f7358', 'fitted-sheet': '#e0d5c0', 'duvet': '#f2efe8', 'pillows-rear': '#a2ae98', 'pillows-front': '#cdbfa8', 'throw': '#6b7048',
      'rug': '#d1c9b4', 'drapes': '#8a9680', 'sheers': '#dbe0d2',
      'window-frames': '#2f3d34', 'lamp-shells': '#8a6d3b', 'handles': '#8a6d3b',
    },
    finishes: { 'floor': 0.55, 'walls': 0.92 },
    kelvin: 2700 },

  { id: 'coastal-blue', label: 'Coastal Blue',
    description: 'Sea-mist walls, driftwood floor, white linen and denim blues in neutral-warm light.',
    colors: {
      'walls': '#cfdde4', 'feature-wall': '#4d6683', 'ceiling': '#f7f5f0', 'floor': '#a7a39a', 'travertine': '#e9e8e4',
      'vase': '#2f4a85', 'art-panel': '#5f6a75',
      'wardrobe-left': '#d8d2c4', 'wardrobe-back': '#8a8780', 'bed-frame': '#d9d2c2', 'nightstands': '#d9d2c2', 'art-frame': '#e8e4dc',
      'headboard': '#9eb3c4', 'fitted-sheet': '#b8c6cf', 'duvet': '#f4f2ea', 'pillows-rear': '#8ea1b0', 'pillows-front': '#2f3e57', 'throw': '#9a9a9c',
      'rug': '#cdb894', 'drapes': '#7c8fa0', 'sheers': '#f4f2ec',
      'window-frames': '#e6e4de', 'lamp-shells': '#c4c6c8', 'handles': '#c4c6c8',
    },
    finishes: { 'floor': 0.65, 'wardrobe-left': 0.55, 'bed-frame': 0.55, 'nightstands': 0.55, 'window-frames': 0.45 },
    kelvin: 3500 },

  { id: 'midnight-navy-brass', label: 'Midnight Navy & Brass',
    description: 'Deep navy walls, smoked oak, ivory bedding and polished brass hardware.',
    colors: {
      'walls': '#26324a', 'feature-wall': '#171f30', 'ceiling': '#d9d6cf', 'floor': '#6b5846', 'travertine': '#ece5d6',
      'vase': '#c19a2e', 'art-panel': '#c49a45',
      'wardrobe-left': '#3d2a1f', 'wardrobe-back': '#2e2723', 'bed-frame': '#3d2a1f', 'nightstands': '#3d2a1f', 'art-frame': '#c3a15f',
      'headboard': '#66788c', 'fitted-sheet': '#d9c6a8', 'duvet': '#e8e1d1', 'pillows-rear': '#cdbfa8', 'pillows-front': '#c9a04a', 'throw': '#4d6683',
      'rug': '#a8a398', 'drapes': '#a89d90', 'sheers': '#e3d7bf',
      'window-frames': '#b89b5a', 'lamp-shells': '#c6ac80', 'handles': '#b89b5a',
    },
    finishes: { 'floor': 0.4, 'handles': 0.25, 'lamp-shells': 0.25, 'window-frames': 0.3 },
    kelvin: 2400 },

  { id: 'charcoal-loft', label: 'Charcoal Loft',
    description: 'Charcoal plaster, weathered grey boards, black steel and cool concrete tones.',
    colors: {
      'walls': '#4a4c4f', 'feature-wall': '#2a2b2d', 'ceiling': '#8e9093', 'floor': '#8a8780', 'travertine': '#a5a39f',
      'vase': '#e4dccb', 'art-panel': '#e8e5dc',
      'wardrobe-left': '#6b5846', 'wardrobe-back': '#2e2723', 'bed-frame': '#4f4234', 'nightstands': '#4f4234', 'art-frame': '#1d1b1a',
      'headboard': '#5a6e76', 'fitted-sheet': '#a8a198', 'duvet': '#d6d3cc', 'pillows-rear': '#9d9c98', 'pillows-front': '#3b3d3f', 'throw': '#a4523a',
      'rug': '#4d4e50', 'drapes': '#a8a198', 'sheers': '#b9b8b4',
      'window-frames': '#232323', 'lamp-shells': '#232323', 'handles': '#3a3b3d',
    },
    finishes: { 'walls': 0.85, 'feature-wall': 0.8, 'floor': 0.5 },
    kelvin: 3000 },

  { id: 'blush-clay', label: 'Blush & Clay',
    description: 'Blush plaster over a clay feature wall, bleached oak and rosy linen under soft amber light.',
    colors: {
      'walls': '#e0c4b8', 'feature-wall': '#c98e7c', 'ceiling': '#f7f2ea', 'floor': '#d9c9ab', 'travertine': '#d8b8a8',
      'vase': '#b9684c', 'art-panel': '#cfa59c',
      'wardrobe-left': '#d8b988', 'wardrobe-back': '#9a6b3d', 'bed-frame': '#8a6a4b', 'nightstands': '#8a6a4b', 'art-frame': '#c3a15f',
      'headboard': '#b0735f', 'fitted-sheet': '#dbb8ad', 'duvet': '#f5efe5', 'pillows-rear': '#e0c5ba', 'pillows-front': '#b4694f', 'throw': '#d2a79c',
      'rug': '#a9806f', 'drapes': '#b89b8f', 'sheers': '#eed9d0',
      'window-frames': '#a9633d', 'lamp-shells': '#a9633d', 'handles': '#b89b5a',
    },
    finishes: { 'walls': 0.92, 'floor': 0.55 },
    kelvin: 2700 },

  { id: 'forest-lodge', label: 'Forest Lodge',
    description: 'Deep green walls, chestnut boards, oxblood wool and dark metal by lamplight.',
    colors: {
      'walls': '#4d5e4c', 'feature-wall': '#2f3d34', 'ceiling': '#e8e1d0', 'floor': '#7a5238', 'travertine': '#a98f70',
      'vase': '#6b2b2a', 'art-panel': '#c49a45',
      'wardrobe-left': '#5e2f22', 'wardrobe-back': '#3d2a1f', 'bed-frame': '#4f3a2c', 'nightstands': '#4f3a2c', 'art-frame': '#2e2723',
      'headboard': '#3f5b47', 'fitted-sheet': '#d3c8b0', 'duvet': '#dcd2bb', 'pillows-rear': '#cdbfa8', 'pillows-front': '#6b7048', 'throw': '#6e2f3a',
      'rug': '#8f4a33', 'drapes': '#c9b99a', 'sheers': '#e3d7bf',
      'window-frames': '#2e2a26', 'lamp-shells': '#6b5436', 'handles': '#8a6d3b',
    },
    finishes: { 'floor': 0.45, 'walls': 0.9 },
    kelvin: 2400 },

  { id: 'mediterranean', label: 'Mediterranean',
    description: 'Sun-baked cream walls, azure accent, terracotta-toned boards and white bedding.',
    colors: {
      'walls': '#e8d9bd', 'feature-wall': '#3f6f8f', 'ceiling': '#f7f2e6', 'floor': '#a8643f', 'travertine': '#d8cdb4',
      'vase': '#2f4a85', 'art-panel': '#c8a05a',
      'wardrobe-left': '#d8b988', 'wardrobe-back': '#7e5636', 'bed-frame': '#8a5a38', 'nightstands': '#8a5a38', 'art-frame': '#2f4a85',
      'headboard': '#c8a05a', 'fitted-sheet': '#f0ede6', 'duvet': '#faf8f2', 'pillows-rear': '#e0d5c0', 'pillows-front': '#2f5d7c', 'throw': '#c79a3d',
      'rug': '#2f5d7c', 'drapes': '#7c8fa0', 'sheers': '#f4f2ec',
      'window-frames': '#2f4a85', 'lamp-shells': '#b0583c', 'handles': '#a9633d',
    },
    finishes: { 'walls': 0.95, 'floor': 0.5 },
    kelvin: 2700 },

  { id: 'monochrome-gallery', label: 'Monochrome Gallery',
    description: 'Gallery-white walls with a black feature wall, concrete-grey floor and graphic black-and-white bedding.',
    colors: {
      'walls': '#f1f1ef', 'feature-wall': '#2a2b2d', 'ceiling': '#fafafa', 'floor': '#8d8b86', 'travertine': '#25252a',
      'vase': '#2b2a29', 'art-panel': '#e8e5dc',
      'wardrobe-left': '#bfbbb4', 'wardrobe-back': '#2e2723', 'bed-frame': '#1d1b1a', 'nightstands': '#1d1b1a', 'art-frame': '#1d1b1a',
      'headboard': '#8a8d90', 'fitted-sheet': '#9d9c98', 'duvet': '#2f3032', 'pillows-rear': '#efede6', 'pillows-front': '#9d9c98', 'throw': '#e2dccb',
      'rug': '#26262a', 'drapes': '#4b4a49', 'sheers': '#f4f2ec',
      'window-frames': '#232323', 'lamp-shells': '#232323', 'handles': '#232323',
    },
    finishes: { 'walls': 0.95, 'floor': 0.4, 'bed-frame': 0.35, 'nightstands': 0.35 },
    kelvin: 4000 },
];
