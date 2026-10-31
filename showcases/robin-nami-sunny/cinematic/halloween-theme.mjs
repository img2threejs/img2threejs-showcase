// Halloween theme for the Thousand Sunny.
//
// createHalloweenTheme() turns the sunny deck into a haunted one without touching the ship asset:
//   * ship meshes get per-mesh material overrides (cloned, triplanar Poly Haven maps, tattered sails)
//     that cross-fade with `setAmount()`; amount 0 puts the original materials back verbatim;
//   * every added decoration is a child of the rocking deck pivot, built from instanced / merged
//     geometry with a staggered, shader-driven grow-in (no per-frame CPU work for the fade);
//   * `maxLights` (default 4, max 6) real point lights; every other glow is an emissive surface or an additive sprite.
// Poly Haven (CC0) sources are listed in materials/polyhaven/HALLOWEEN-SOURCES.json.
//
//   const theme = await createHalloweenTheme({ scene, deck, ship, patrol, loader, textureLoader, renderer, anisotropy, assetBase?, maxLights? });
//   theme.group                      THREE.Group under `deck` holding every added decoration (deck-local, y = 0 lawn)
//   theme.setAmount(0..1)            cross-fade; 0 restores the original materials/geometry exactly and hides everything
//   theme.update(time, dt, { night, flash, camera })   flicker, lantern swing, bats, ghosts, mist; call every frame
//   theme.warm(camera?)              pre-build shaders/pipelines (also run once at creation); call again if the lights change
//   theme.snapshot() / theme.destroy()
// Asset URLs are resolved relative to the page (like the ship GLB): '../materials/polyhaven/<id>/' and
// 'assets/halloween/<id>/'; pass `assetBase` to prefix both.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TEXTURE_DIR = '../materials/polyhaven/';
const MODEL_DIR = 'assets/halloween/';
const CLOTH_TEXTURE_IDS = ['floral_jacquard', 'rough_linen', 'velour_velvet'];
const MODEL_IDS = ['wooden_lantern_01', 'Lantern_01', 'brass_candleholders', 'gothic_statue', 'wooden_handle_saber', 'wooden_broom', 'brass_pot_01', 'dry_branches_medium_01'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */`
float hwH2(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float hwN2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwH2(i), hwH2(i + vec2(1.0, 0.0)), f.x), mix(hwH2(i + vec2(0.0, 1.0)), hwH2(i + vec2(1.0, 1.0)), f.x), f.y); }
float hwF2(vec2 p){ return (0.5 * hwN2(p) + 0.25 * hwN2(p * 2.03 + 7.1) + 0.125 * hwN2(p * 4.07 + 3.3) + 0.0625 * hwN2(p * 8.1 + 1.7)) / 0.9375; }
float hwH3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hwN3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hwH3(i), hwH3(i + vec3(1,0,0)), f.x), mix(hwH3(i + vec3(0,1,0)), hwH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hwH3(i + vec3(0,0,1)), hwH3(i + vec3(1,0,1)), f.x), mix(hwH3(i + vec3(0,1,1)), hwH3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float hwF3(vec3 p){ return (0.5 * hwN3(p) + 0.25 * hwN3(p * 2.03 + 7.1) + 0.125 * hwN3(p * 4.07 + 3.3)) / 0.875; }
`;

const v3 = (a) => `vec3(${a.map((x) => Number(x).toFixed(5)).join(',')})`;
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const f1 = (x) => Number(x).toFixed(5);

// ---------------------------------------------------------------------------------------------
// Ship material specs. Colours are linear; `map` ids refer to Poly Haven texture sets.
// ---------------------------------------------------------------------------------------------
const SAIL_MAIN_RECT = [-11.5, 11.5, 15.5, 37.5];
const SAIL_AFT_RECT = [-6.5, 6.5, 13.0, 27.0];
const SPECS = {
  sailMain: { map: 'hessian_230', nor: true, mode: 'xy', scale: 0.62, tint: lin(0xa28bbd), desat: 0.45, rough: 0.96, nStr: 1.0, dirt: 0.7, soot: [15.5, 7.0, 0.38], emissive: lin(0xff8c3c), emK: [0.0, 0.12], under: [15.5, 9.0],
    tatter: { rect: SAIL_MAIN_RECT, hem: 2.4, rips: 7.0, holes: 0.745, side: 0.9, keep: [0, 26.5, 5.2, 6.8] } },
  seamMain: { color: lin(0x15101a), rough: 0.95, dirt: 0.3, tatter: { rect: SAIL_MAIN_RECT, hem: 2.4, rips: 7.0, holes: 0.745, side: 0.9, keep: [0, 26.5, 5.2, 6.8] } },
  sailAftDark: { map: 'hessian_230', nor: true, mode: 'xy', scale: 0.7, tint: lin(0x4d3f62), desat: 0.5, rough: 0.96, nStr: 1.0, dirt: 0.8, soot: [13.0, 5.0, 0.35], emissive: lin(0xff8c3c), emK: [0.0, 0.14], under: [13.0, 8.0],
    tatter: { rect: SAIL_AFT_RECT, hem: 1.9, rips: 5.0, holes: 0.75, side: 0.7, keep: [0, -100, 1, 1] } },
  sailAftOrange: { map: 'hessian_230', nor: true, mode: 'xy', scale: 0.7, tint: lin(0xb4470c), desat: 0.15, rough: 0.94, nStr: 1.0, dirt: 0.55, soot: [13.0, 5.0, 0.40], emissive: lin(0xff8c3c), emK: [0.0, 0.14], under: [13.0, 8.0],
    tatter: { rect: SAIL_AFT_RECT, hem: 1.9, rips: 5.0, holes: 0.75, side: 0.7, keep: [0, -100, 1, 1] } },
  seamAft: { color: lin(0x120d16), rough: 0.95, dirt: 0.3, tatter: { rect: SAIL_AFT_RECT, hem: 1.9, rips: 5.0, holes: 0.75, side: 0.7, keep: [0, -100, 1, 1] } },
  ropeDark: { color: lin(0x2a2018), rough: 0.98, dirt: 0.6 },
  emblemSkull: { color: lin(0xcfd8b8), rough: 0.7, dirt: 0.4, emissive: lin(0xa6ff7a), emK: [0.05, 0.55], pulse: 0.25 },
  emblemHat: { color: lin(0xd6600c), rough: 0.7, dirt: 0.5, emissive: lin(0xff7a12), emK: [0.06, 0.45], pulse: 0.2 },
  emblemBand: { color: lin(0x4a0d1c), rough: 0.7, dirt: 0.5 },
  hullWood: { map: 'dark_wooden_planks', nor: true, rgh: true, mode: 'tri', scale: 0.55, tint: lin(0xb89c8d), desat: 0.1, rough: 0.9, nStr: 1.0, dirt: 0.55 },
  hullSeam: { color: lin(0x0b0706), rough: 0.95, dirt: 0.2 },
  hullRed: { color: lin(0x3a0a1d), rough: 0.72, dirt: 0.85, noiseScale: 1.7 },
  bone: { color: lin(0x9d9483), rough: 0.82, dirt: 0.9, noiseScale: 2.3 },
  brassOld: { color: lin(0x6b4a20), rough: 0.55, metal: 0.6, dirt: 0.8, noiseScale: 3.0 },
  plankGrey: { map: 'dark_wooden_planks', nor: true, rgh: true, mode: 'tri', scale: 0.8, tint: lin(0xd0b8ad), desat: 0.25, rough: 0.9, nStr: 1.0, dirt: 0.6 },
  darkWoodTex: { map: 'black_painted_planks', nor: true, rgh: true, mode: 'tri', scale: 0.7, tint: lin(0xffffff), desat: 0.0, rough: 0.8, nStr: 1.0, dirt: 0.35 },
  lawn: { map: 'leaves_forest_ground', nor: true, rgh: true, mode: 'xz', scale: 0.3, tint: lin(0x8c8079), desat: 0.15, rough: 1.0, nStr: 1.2, dirt: 0.3 },
  plaster: { color: lin(0x6e6370), rough: 0.9, dirt: 0.95, noiseScale: 1.4 },
  windowGlow: { color: lin(0xffb347), rough: 0.25, dirt: 0.0, emissive: lin(0xff8a1f), emK: [0.1, 2.6], flicker: 0.28 },
  domeOrange: { color: lin(0xe56a0a), rough: 0.5, dirt: 0.35, emissive: lin(0xff6a00), emK: [0.12, 1.1], flicker: 0.1 },
  domePurple: { color: lin(0x1c0f2a), rough: 0.55, dirt: 0.35 },
  maneFire: { color: lin(0xf26a0c), rough: 0.55, dirt: 0.25, emissive: lin(0xff5a00), emK: [0.1, 0.8], flicker: 0.22 },
  lionFace: { color: lin(0xc9a04a), rough: 0.7, dirt: 0.8, noiseScale: 2.0 },
  terracottaDark: { color: lin(0x3a1c10), rough: 0.9, dirt: 0.95, noiseScale: 3.0 },
  deadWood: { map: 'dark_wooden_planks', nor: true, rgh: true, mode: 'tri', scale: 1.1, tint: lin(0x9c8576), desat: 0.5, rough: 0.95, nStr: 1.0, dirt: 0.5 },
  leafShrink: { color: lin(0x6a3b12), rough: 0.95, dirt: 0.5, shrink: true },
  fruitShrink: { color: lin(0xd9600a), rough: 0.6, dirt: 0.2, shrink: true },
};

// [mesh-name pattern, spec]; first match wins. Names are the sanitised glTF node names.
const SHIP_RULES = [
  [/Billowed_ivory_main_sail__sail$/, 'sailMain'], [/Billowed_ivory_main_sail__clothSeam$/, 'seamMain'], [/main_sail__rope$/, 'ropeDark'],
  [/emblem__sail$/, 'emblemSkull'], [/emblem__yellow$/, 'emblemHat'], [/emblem__red$/, 'emblemBand'],
  [/Red_striped_aft_sail__sail$/, 'sailAftDark'], [/Red_striped_aft_sail__red$/, 'sailAftOrange'], [/Red_striped_aft_sail__clothSeam$/, 'seamAft'], [/aft_sail__rope$/, 'ropeDark'],
  [/hull__wood$/, 'hullWood'], [/hull__seam$/, 'hullSeam'], [/hull__red$/, 'hullRed'], [/hull__ivory$/, 'bone'], [/hull__gold$/, 'brassOld'],
  [/hatches__woodLight$/, 'plankGrey'], [/hatches__seam$/, 'hullSeam'], [/hatches__red$/, 'hullRed'],
  [/promenade__woodLight$/, 'plankGrey'], [/promenade__grass$/, 'lawn'], [/promenade__wood$/, 'darkWoodTex'], [/promenade__seam$/, 'hullSeam'],
  [/balustrades_with_dark_caps__ivory$/, 'bone'], [/balustrades_with_dark_caps__darkWood$/, 'darkWoodTex'],
  [/lion_figurehead_and_crossed_bones__red$/, 'hullRed'], [/crossed_bones__ivory$/, 'bone'], [/crossed_bones__mane$/, 'maneFire'], [/crossed_bones__yellow$/, 'lionFace'],
  [/crossed_bones__darkWood$/, 'darkWoodTex'], [/crossed_bones__wood$/, 'darkWoodTex'],
  [/cabin_arched_facade__cream$/, 'plaster'], [/cabin_arched_facade__red$/, 'hullRed'], [/cabin_arched_facade__glass$/, 'windowGlow'],
  [/cabin_arched_facade__ivory$/, 'bone'], [/cabin_arched_facade__gold$/, 'brassOld'], [/cabin_arched_facade__darkWood$/, 'darkWoodTex'],
  [/stair_flights_and_upper_balcony__woodLight$/, 'plankGrey'], [/stair_flights_and_upper_balcony__ivory$/, 'bone'], [/stair_flights_and_upper_balcony__darkWood$/, 'darkWoodTex'],
  [/dome_and_window_lantern__cream$/, 'plaster'], [/dome_and_window_lantern__glass$/, 'windowGlow'], [/dome_and_window_lantern__ivory$/, 'bone'],
  [/dome_and_window_lantern__yellow$/, 'domeOrange'], [/dome_and_window_lantern__red$/, 'domePurple'], [/dome_and_window_lantern__darkWood$/, 'darkWoodTex'], [/dome_and_window_lantern__gold$/, 'brassOld'],
  [/rudder_and_rounded_timber_transom__darkWood$/, 'darkWoodTex'], [/rudder_and_rounded_timber_transom__wood$/, 'darkWoodTex'],
  [/Masts_yards_crow_nest_and_rigging__wood$/, 'darkWoodTex'], [/Masts_yards_crow_nest_and_rigging__darkWood$/, 'darkWoodTex'], [/Masts_yards_crow_nest_and_rigging__ivory$/, 'bone'], [/Masts_yards_crow_nest_and_rigging__rope$/, 'ropeDark'],
  [/orange_trees_in_deck_planters__terracotta$/, 'terracottaDark'], [/orange_trees_in_deck_planters__wood$/, 'deadWood'],
  [/orange_trees_in_deck_planters__leaf(Light)?$/, 'leafShrink'], [/orange_trees_in_deck_planters__orange$/, 'fruitShrink'],
];

function shipVertex(spec, shader) {
  const head = `uniform float uHwAmt;\nvarying vec3 vHwP;\nvarying vec3 vHwN;\n${spec.shrink ? 'attribute vec3 aPivot;\nattribute float aStart;\n' : ''}`;
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${head}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vHwP = position; vHwN = normal;
${spec.shrink ? 'float hwS = 1.0 - smoothstep(aStart, aStart + 0.34, uHwAmt); transformed = aPivot + (transformed - aPivot) * hwS;' : ''}`);
}

function shipFragment(spec) {
  const scale = f1(spec.scale ?? 1);
  const noiseScale = f1(spec.noiseScale ?? 1.5);
  const sampleMap = spec.map
    ? (spec.mode === 'xy' ? `texture(tHwMap, hwP.xy * ${scale})`
      : spec.mode === 'xz' ? `texture(tHwMap, hwP.xz * ${scale})`
        : `(texture(tHwMap, hwQ.zy) * hwW.x + texture(tHwMap, hwQ.xz) * hwW.y + texture(tHwMap, hwQ.xy) * hwW.z)`)
    : null;
  const sampleRgh = spec.rgh
    ? (spec.mode === 'xz' ? `texture(tHwRgh, hwP.xz * ${scale}).g`
      : spec.mode === 'xy' ? `texture(tHwRgh, hwP.xy * ${scale}).g`
        : `(texture(tHwRgh, hwQ.zy).g * hwW.x + texture(tHwRgh, hwQ.xz).g * hwW.y + texture(tHwRgh, hwQ.xy).g * hwW.z)`)
    : null;
  const t = spec.tatter;
  const rect = t ? t.rect : null;
  const tatter = t ? `
  {
    float hwDx = hwP.x - ${f1(rect[0])};
    float hwUp = hwP.y - ${f1(rect[2])};
    float hwHalf = ${f1((rect[1] - rect[0]) / 2)};
    float hwCx = ${f1((rect[0] + rect[1]) / 2)};
    vec2 hwK = vec2((hwP.x - ${f1(t.keep[0])}) / ${f1(t.keep[2])}, (hwP.y - ${f1(t.keep[1])}) / ${f1(t.keep[3])});
    float hwKeep = smoothstep(0.7, 1.15, length(hwK));
    float hwRag = hwF2(vec2(hwP.x * 0.55, 3.7)) * 0.75 + hwN2(vec2(hwP.x * 2.9, 1.3)) * 0.5;
    float hwRip = hwN2(vec2(hwP.x * 1.35 + 4.0, 9.0));
    float hwRipLen = smoothstep(0.62, 0.95, hwRip) * ${f1(t.rips)};
    float hwSide = hwF2(vec2(hwP.y * 0.8, 11.0)) * ${f1(t.side)} + hwN2(vec2(hwP.y * 3.7, 5.0)) * 0.3;
    float hwCut = hwRag * ${f1(t.hem)} + hwRipLen;
    float hwBig = hwF2(hwP.xy * 0.33 + 17.0);
    float hwSmall = hwF2(hwP.xy * 1.45 + 3.0);
    float hwThr = mix(1.2, ${f1(t.holes)}, uHwAmt);
    float hwThr2 = mix(1.2, ${f1(t.holes + 0.06)}, uHwAmt);
    float hwHole = max(step(hwThr, hwBig) , step(hwThr2, hwSmall)) * hwKeep;
    float hwEdge = max(step(hwThr - 0.035, hwBig), step(hwThr2 - 0.035, hwSmall)) * hwKeep;
    float hwSideGap = (hwHalf - abs(hwP.x - hwCx)) - hwSide * uHwAmt;
    if (hwHole > 0.5 || hwUp < hwCut * uHwAmt * hwKeep || hwSideGap < 0.0) discard;
    hwChar = max(hwEdge, 1.0 - smoothstep(0.0, 0.35, hwUp - hwCut * uHwAmt)) * 0.9;
    hwChar = max(hwChar, 1.0 - smoothstep(0.0, 0.3, hwSideGap));
  }` : '';
  const soot = spec.soot
    ? `hwCol *= mix(${f1(spec.soot[2])}, 1.0, smoothstep(0.0, ${f1(spec.soot[1])}, hwP.y - ${f1(spec.soot[0])}));` : '';
  const dirtCode = spec.dirt
    ? `float hwDirt = hwF3(hwP * ${noiseScale} + 5.0); hwCol *= mix(1.0, 0.35 + 1.1 * hwDirt, ${f1(spec.dirt)});` : '';
  const baseCol = sampleMap
    ? `vec4 hwT = ${sampleMap};\n  float hwL = dot(hwT.rgb, vec3(0.299, 0.587, 0.114));\n  hwCol = mix(hwT.rgb, vec3(hwL), ${f1(spec.desat ?? 0)}) * ${v3(spec.tint ?? [1, 1, 1])};`
    : `hwCol = ${v3(spec.color ?? [0.5, 0.5, 0.5])};`;
  const rough = sampleRgh ? `hwRough = clamp(${sampleRgh} * ${f1(spec.rough ?? 1)} + 0.05, 0.05, 1.0);` : `hwRough = ${f1(spec.rough ?? 0.8)};`;
  const flick = spec.flicker ? `(1.0 + ${f1(spec.flicker)} * (hwN2(vec2(uHwTime * 6.0, hwP.x + hwP.z)) - 0.5) * 2.0)` : '1.0';
  const pulse = spec.pulse ? `(1.0 + ${f1(spec.pulse)} * sin(uHwTime * 1.7))` : '1.0';
  const emissive = spec.emissive
    ? `hwEm = ${v3(spec.emissive)} * (${f1(spec.emK[0])} + ${f1(spec.emK[1])} * uHwNight) * ${flick} * ${pulse};` : '';
  const pars = `
uniform float uHwAmt; uniform float uHwTime; uniform float uHwNight; uniform float uHwFlash;
varying vec3 vHwP; varying vec3 vHwN;
uniform mat3 normalMatrix;
${spec.map ? 'uniform sampler2D tHwMap;' : ''}${spec.nor ? 'uniform sampler2D tHwNor;' : ''}${spec.rgh ? 'uniform sampler2D tHwRgh;' : ''}
${GLSL_NOISE}`;
  const color = `
  vec3 hwP = vHwP; vec3 hwNrm = normalize(vHwN);
  // Cross-fade as a spreading, noise-driven wipe (linear colour mixes of the bright sunny palette look late and muddy).
  float hwKe = 1.0 - pow(1.0 - uHwAmt, 1.15);
  float hwKn = hwF3(hwP * 0.9 + vec3(3.0)) * 0.55;
  float hwK = smoothstep(hwKn, hwKn + 0.3, hwKe * 1.2);
  vec3 hwW = pow(abs(hwNrm), vec3(8.0)); hwW /= (hwW.x + hwW.y + hwW.z);
  vec3 hwQ = hwP * ${scale};
  vec3 hwCol = vec3(0.5); float hwRough = 0.8; float hwMetal = ${f1(spec.metal ?? 0)}; vec3 hwEm = vec3(0.0); float hwChar = 0.0;
  ${baseCol}
  ${dirtCode}
  ${soot}
  ${tatter}
  hwCol *= 1.0 - hwChar * 0.8;
  ${rough}
  ${emissive}
  ${spec.under ? `hwEm *= hwCol * 2.5 * (1.0 - smoothstep(0.0, ${f1(spec.under[1])}, hwP.y - ${f1(spec.under[0])}));` : ''}
  diffuseColor.rgb = mix(diffuseColor.rgb, hwCol, hwK);`;
  const normal = spec.nor ? (() => {
    const s = spec.mode === 'xy' ? `vec3 hwTn = texture(tHwNor, hwP.xy * ${scale}).xyz * 2.0 - 1.0; hwTn.xy *= ${f1(spec.nStr ?? 1)}; vec3 hwNo = normalize(vec3(hwTn.xy + hwNf.xy, abs(hwTn.z) * hwNf.z));`
      : spec.mode === 'xz' ? `vec3 hwTn = texture(tHwNor, hwP.xz * ${scale}).xyz * 2.0 - 1.0; hwTn.xy *= ${f1(spec.nStr ?? 1)}; vec3 hwNo = normalize(vec3(hwTn.x + hwNf.x, abs(hwTn.z) * hwNf.y, hwTn.y + hwNf.z));`
        : `vec3 hwTx = texture(tHwNor, hwQ.zy).xyz * 2.0 - 1.0; vec3 hwTy = texture(tHwNor, hwQ.xz).xyz * 2.0 - 1.0; vec3 hwTz = texture(tHwNor, hwQ.xy).xyz * 2.0 - 1.0;
  hwTx.xy *= ${f1(spec.nStr ?? 1)}; hwTy.xy *= ${f1(spec.nStr ?? 1)}; hwTz.xy *= ${f1(spec.nStr ?? 1)};
  hwTx = vec3(hwTx.xy + hwNf.zy, abs(hwTx.z) * hwNf.x); hwTy = vec3(hwTy.xy + hwNf.xz, abs(hwTy.z) * hwNf.y); hwTz = vec3(hwTz.xy + hwNf.xy, abs(hwTz.z) * hwNf.z);
  vec3 hwNo = normalize(hwTx.zyx * hwW.x + hwTy.xzy * hwW.y + hwTz.xyz * hwW.z);`;
    return `{ vec3 hwNf = normalize(vHwN) * faceDirection; ${s}
    normal = normalize(mix(normal, normalize(normalMatrix * hwNo), clamp(hwK * 1.1, 0.0, 1.0))); }`;
  })() : '';
  return { pars, color, normal, tatter };
}

function buildShipMaterial(base, specId, ctx) {
  const spec = { id: specId, ...SPECS[specId] };
  const material = base.clone();
  material.name = `${base.name}:halloween:${specId}`;
  material.customProgramCacheKey = () => `hwship:${specId}`;
  const code = shipFragment(spec);
  if (spec.tatter) {
    // Shadow pass: cut the same holes / rags out of the cast shadow (three picks `mesh.customDepthMaterial`).
    const depth = new THREE.MeshDepthMaterial();
    depth.name = `${material.name}:shadow`;
    depth.customProgramCacheKey = () => `hwdepth:${specId}`;
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.uHwAmt = ctx.U.amt;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHwP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHwP = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uHwAmt;\nvarying vec3 vHwP;\n${GLSL_NOISE}`)
        .replace('void main() {', `void main() {\n  float hwChar = 0.0; vec3 hwP = vHwP;\n${code.tatter}`);
    };
    material.userData.hwDepth = depth;
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHwAmt = ctx.U.amt;
    shader.uniforms.uHwTime = ctx.U.time;
    shader.uniforms.uHwNight = ctx.U.night; shader.uniforms.uHwFlash = ctx.U.flash;
    if (spec.map) shader.uniforms.tHwMap = { value: ctx.tex[`${spec.map}:d`] };
    if (spec.nor) shader.uniforms.tHwNor = { value: ctx.tex[`${spec.map}:n`] };
    if (spec.rgh) shader.uniforms.tHwRgh = { value: ctx.tex[`${spec.map}:r`] };
    shipVertex(spec, shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${code.pars}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${code.color}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, hwRough, hwK);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, hwMetal, hwK);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n  ${code.normal}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += hwEm * hwK + diffuseColor.rgb * uHwFlash * 0.8 * vec3(0.62, 0.72, 1.0) * hwK;`);
  };
  return material;
}

// ---------------------------------------------------------------------------------------------
// Connected-component pivots so original leaves / fruit shrink into themselves.
// ---------------------------------------------------------------------------------------------
function withShrinkAttributes(source, seed) {
  const geometry = source.clone();
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const key = (i) => `${Math.round(pos.getX(i) * 40)},${Math.round(pos.getY(i) * 40)},${Math.round(pos.getZ(i) * 40)}`;
  const parent = new Map();
  const find = (a) => { let r = a; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(a) !== r) { const n = parent.get(a); parent.set(a, r); a = n; } return r; };
  for (let i = 0; i < pos.count; i++) { const k = key(i); if (!parent.has(k)) parent.set(k, k); }
  for (let t = 0; t < index.count; t += 3) {
    const a = find(key(index.getX(t)));
    for (let j = 1; j < 3; j++) parent.set(find(key(index.getX(t + j))), a);
  }
  const boxes = new Map();
  for (let i = 0; i < pos.count; i++) {
    const r = find(key(i));
    let b = boxes.get(r);
    if (!b) boxes.set(r, b = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) });
    b.min.x = Math.min(b.min.x, pos.getX(i)); b.min.y = Math.min(b.min.y, pos.getY(i)); b.min.z = Math.min(b.min.z, pos.getZ(i));
    b.max.x = Math.max(b.max.x, pos.getX(i)); b.max.y = Math.max(b.max.y, pos.getY(i)); b.max.z = Math.max(b.max.z, pos.getZ(i));
  }
  const rand = mulberry(seed);
  for (const b of boxes.values()) { b.centre = b.min.clone().add(b.max).multiplyScalar(0.5); b.start = rand() * 0.45; }
  const pivots = new Float32Array(pos.count * 3);
  const starts = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const b = boxes.get(find(key(i)));
    pivots[i * 3] = b.centre.x; pivots[i * 3 + 1] = b.centre.y; pivots[i * 3 + 2] = b.centre.z; starts[i] = b.start;
  }
  geometry.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  geometry.setAttribute('aStart', new THREE.BufferAttribute(starts, 1));
  return { geometry, components: [...boxes.values()] };
}

// ---------------------------------------------------------------------------------------------
// Decoration infrastructure
// ---------------------------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _o = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _fm = new THREE.Matrix4();
const compose = (x, y, z, ry = 0, s = 1, rx = 0, rz = 0, out = new THREE.Matrix4()) => {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return out.compose(_p.set(x, y, z), _q, typeof s === 'number' ? _s.set(s, s, s) : s);
};

// Rail centre line (starboard, +x) sampled from the balustrade mesh: z -> [x of the cap centre, cap top y].
const RAIL_Z = [-14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12];
const RAIL_X = [4.1, 4.6, 5.3, 5.85, 6.25, 6.5, 6.65, 6.65, 6.6, 6.4, 6.05, 5.6, 5.0, 4.15];
const RAIL_TOP = [2.9, 2.5, 2.0, 1.55, 1.35, 1.25, 1.2, 1.2, 1.2, 1.3, 1.4, 1.6, 2.0, 2.5];
function railAt(z, out = { x: 0, top: 0 }) {
  const zz = Math.min(Math.max(z, RAIL_Z[0]), RAIL_Z[RAIL_Z.length - 1]);
  let i = 0; while (i < RAIL_Z.length - 2 && zz > RAIL_Z[i + 1]) i++;
  const t = (zz - RAIL_Z[i]) / (RAIL_Z[i + 1] - RAIL_Z[i]);
  out.x = RAIL_X[i] + (RAIL_X[i + 1] - RAIL_X[i]) * t; out.top = RAIL_TOP[i] + (RAIL_TOP[i + 1] - RAIL_TOP[i]) * t;
  return out;
}

function canvasTexture(w, h, draw, { srgb = false, repeat = false } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Four carved jack-o'-lantern faces in a 4x1 atlas (white = carved opening).
function faceAtlas() {
  return canvasTexture(1024, 256, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 256); g.fillStyle = '#fff';
    const poly = (ox, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(ox + x, y) : g.moveTo(ox + x, y))); g.closePath(); g.fill(); };
    // 0 classic: triangle eyes, toothy grin
    poly(0, [[52, 118], [108, 118], [80, 62]]); poly(0, [[148, 118], [204, 118], [176, 62]]); poly(0, [[128, 128], [110, 156], [146, 156]]);
    poly(0, [[40, 164], [64, 160], [88, 184], [128, 192], [168, 184], [192, 160], [216, 164], [196, 206], [150, 228], [106, 228], [60, 206]]);
    g.fillStyle = '#000'; for (const x of [96, 150]) g.fillRect(x, 178, 16, 16); for (const x of [120, 172]) g.fillRect(x, 212, 16, 16); g.fillStyle = '#fff';
    // 1 round eyes, big smile with two teeth
    g.beginPath(); g.arc(256 + 86, 104, 26, 0, TAU); g.fill(); g.beginPath(); g.arc(256 + 170, 104, 26, 0, TAU); g.fill();
    g.beginPath(); g.moveTo(256 + 36, 156); g.quadraticCurveTo(256 + 128, 262, 256 + 220, 156); g.quadraticCurveTo(256 + 128, 214, 256 + 36, 156); g.fill();
    // 2 angry slanted eyes, zigzag mouth
    poly(512, [[44, 84], [112, 112], [104, 134], [48, 120]]); poly(512, [[212, 84], [144, 112], [152, 134], [208, 120]]);
    poly(512, [[36, 176], [64, 156], [90, 176], [118, 154], [142, 176], [170, 154], [196, 176], [222, 156], [210, 206], [180, 190], [154, 214], [128, 192], [102, 214], [76, 190], [46, 206]]);
    // 3 surprised: oval eyes + round mouth
    g.beginPath(); g.ellipse(768 + 84, 100, 16, 30, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(768 + 172, 100, 16, 30, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(768 + 128, 184, 34, 40, 0, 0, TAU); g.fill();
  });
}

// Wire-and-radial cobweb, white on transparent.
function webTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const rand = mulberry(77);
    g.strokeStyle = 'rgba(235,240,245,0.92)'; g.lineCap = 'round';
    const cx = 0, cy = h; // web anchored in the lower-left corner; the quad covers a quarter disc
    const spokes = 9; const R = w * 0.98;
    for (let i = 0; i <= spokes; i++) {
      const a = (i / spokes) * Math.PI / 2; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); g.stroke();
    }
    for (let ring = 1; ring <= 12; ring++) {
      const rr = (ring / 12) ** 0.85 * R; g.lineWidth = ring > 9 ? 1.2 : 1.7;
      for (let i = 0; i < spokes; i++) {
        if (rand() < 0.12) continue;
        const a0 = (i / spokes) * Math.PI / 2, a1 = ((i + 1) / spokes) * Math.PI / 2, sag = 0.9 + rand() * 0.04;
        const am = (a0 + a1) / 2;
        g.beginPath(); g.moveTo(cx + Math.cos(a0) * rr, cy - Math.sin(a0) * rr);
        g.quadraticCurveTo(cx + Math.cos(am) * rr * sag, cy - Math.sin(am) * rr * sag, cx + Math.cos(a1) * rr, cy - Math.sin(a1) * rr); g.stroke();
      }
    }
  }, { srgb: true });
}

function mistTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    const rand = mulberry(5); const grid = 8; const lat = new Float32Array(grid * grid); for (let i = 0; i < lat.length; i++) lat[i] = rand();
    const noise = (x, y, f) => { const fx = x * f, fy = y * f; const ix = Math.floor(fx), iy = Math.floor(fy); const tx = fx - ix, ty = fy - iy; const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = lat[(iy % grid) * grid + (ix % grid)], b = lat[(iy % grid) * grid + ((ix + 1) % grid)], c = lat[((iy + 1) % grid) * grid + (ix % grid)], d = lat[((iy + 1) % grid) * grid + ((ix + 1) % grid)];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const n = noise(u, v, 4) * 0.55 + noise(u, v, 8) * 0.3 + noise(u, v, 16) * 0.15;
      const a = Math.max(0, Math.min(1, (n - 0.28) * 2.2));
      const i = (y * w + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }, { repeat: true });
}

function jollyRogerTexture(accent = '#ff7a12') {
  return canvasTexture(512, 320, (g, w, h) => {
    g.fillStyle = '#16101c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; for (let i = 0; i < 60; i++) { g.beginPath(); g.moveTo(0, i * 6); g.lineTo(w, i * 6 + 4); g.stroke(); }
    g.strokeStyle = '#d9cfae'; g.lineCap = 'round'; g.lineWidth = 18;
    g.beginPath(); g.moveTo(150, 215); g.lineTo(362, 100); g.moveTo(362, 215); g.lineTo(150, 100); g.stroke();
    g.fillStyle = '#e7dfc4'; g.beginPath(); g.ellipse(256, 150, 62, 66, 0, 0, TAU); g.fill();
    g.fillRect(224, 190, 64, 46);
    g.fillStyle = '#16101c'; g.beginPath(); g.ellipse(232, 150, 15, 19, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(282, 150, 15, 19, 0, 0, TAU); g.fill();
    g.beginPath(); g.moveTo(256, 170); g.lineTo(247, 190); g.lineTo(265, 190); g.fill();
    for (const x of [232, 244, 256, 268]) g.fillRect(x, 208, 3, 26);
    g.fillStyle = accent; g.beginPath(); g.moveTo(180, 96); g.quadraticCurveTo(256, 20, 332, 96); g.lineTo(344, 106); g.lineTo(168, 106); g.fill();
  }, { srgb: true });
}

// Per-material GLSL patch: appear-by-scale (+ optional pivot attribute), extra fragment code.
function patchDeco(material, ctx, o) {
  material.customProgramCacheKey = () => `hwdeco:${o.key}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHwAmt = ctx.U.amt; shader.uniforms.uHwTime = ctx.U.time; shader.uniforms.uHwNight = ctx.U.night; shader.uniforms.uHwFlash = ctx.U.flash;
    if (o.uniforms) Object.assign(shader.uniforms, o.uniforms(ctx));
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uHwAmt; uniform float uHwTime; uniform float uHwNight;\nattribute float aStart;\n${o.pivot ? 'attribute vec3 aPivot;\n' : ''}${o.vertexPars ?? ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
float hwS = smoothstep(aStart, aStart + 0.28, uHwAmt);
${o.pivot ? 'transformed = aPivot + (transformed - aPivot) * hwS;' : 'transformed *= hwS;'}
${o.vertexBody ?? ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uHwAmt; uniform float uHwTime; uniform float uHwNight; uniform float uHwFlash;\n${GLSL_NOISE}\n${o.fragPars ?? ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragColor ?? ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${o.fragEmissive ?? ''}\ntotalEmissiveRadiance += diffuseColor.rgb * uHwFlash * 0.7 * vec3(0.62, 0.72, 1.0);`);
  };
  return material;
}

// Merge many small pieces into one geometry carrying per-vertex pivot + appear threshold.
class Merger {
  constructor({ uv = false } = {}) { this.parts = []; this.uv = uv; }
  add(geometry, { matrix = null, color = [1, 1, 1], pivot = null, start = 0 } = {}) {
    const g = geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!this.uv) g.deleteAttribute('uv'); else if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3); const pv = new Float32Array(n * 3); const st = new Float32Array(n);
    if (!pivot) { g.computeBoundingBox(); pivot = g.boundingBox.getCenter(new THREE.Vector3()).toArray(); }
    for (let i = 0; i < n; i++) { col.set(color, i * 3); pv.set(pivot, i * 3); st[i] = start; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
    g.setAttribute('aStart', new THREE.BufferAttribute(st, 1));
    this.parts.push(g);
    return this;
  }
  build() {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    return g;
  }
}

function instanced(geometry, material, items, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const starts = new Float32Array(items.length);
  for (let i = 0; i < items.length; i++) {
    mesh.setMatrixAt(i, items[i].matrix); starts[i] = items[i].start ?? 0;
    if (items[i].color) mesh.setColorAt(i, items[i].color);
  }
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = name;
  mesh.castShadow = false; mesh.receiveShadow = true;
  return mesh;
}

function pumpkinGeometry(seg, rings, ribs = 10) {
  const pos = [], col = [], idx = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * TAU, rib = 0.5 + 0.5 * Math.cos(th * ribs);
      const r = 0.5 * sp * (1 - 0.09 * (1 - rib));
      const dimple = 0.06 * Math.max(0, Math.abs(cp) - 0.82) / 0.18;
      const y = 0.39 * cp - Math.sign(cp) * dimple;
      pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
      const shade = 0.72 + 0.28 * rib; col.push(shade, shade, shade);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  body.setIndex(idx); body.computeVertexNormals();
  const stem = new THREE.CylinderGeometry(0.032, 0.058, 0.17, 6, 1); stem.translate(0.012, 0.4, 0); stem.deleteAttribute('uv');
  const sc = []; for (let i = 0; i < stem.attributes.position.count; i++) sc.push(0.42, 0.45, 0.16);
  stem.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  const merged = mergeGeometries([body, stem], false);
  body.dispose(); stem.dispose();
  return merged;
}

const BONE = [0.82, 0.77, 0.63];
const DARK = [0.03, 0.025, 0.03];
const part = (geometry, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = BONE } = {}) => {
  const g = geometry.clone(); g.deleteAttribute('uv');
  g.applyMatrix4(_m.compose(_p.set(...pos), _q.setFromEuler(_e.set(...rot, 'XYZ')), _s.set(...scale)));
  const n = g.attributes.position.count; const c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set(color, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
};
const mergeParts = (list) => { const g = mergeGeometries(list, false); for (const p of list) p.dispose(); return g; };

function skullGeometry() {
  const sph = new THREE.SphereGeometry(0.5, 14, 10), cyl = new THREE.CylinderGeometry(0.26, 0.2, 0.3, 10, 1), box = new THREE.BoxGeometry(1, 1, 1), cone = new THREE.ConeGeometry(0.06, 0.16, 4);
  const list = [
    part(sph, { pos: [0, 0.12, 0], scale: [0.92, 0.9, 1.0] }),
    part(cyl, { pos: [0, -0.34, 0.14], scale: [1, 1, 0.8] }),
    part(sph, { pos: [-0.2, 0.06, 0.38], scale: [0.3, 0.32, 0.26], color: DARK }),
    part(sph, { pos: [0.2, 0.06, 0.38], scale: [0.3, 0.32, 0.26], color: DARK }),
    part(cone, { pos: [0, -0.14, 0.46], rot: [Math.PI, 0, 0], color: DARK }),
  ];
  for (let i = -2; i <= 2; i++) list.push(part(box, { pos: [i * 0.09, -0.3, 0.34], scale: [0.065, 0.1, 0.05], color: [0.9, 0.88, 0.78] }));
  list.push(part(box, { pos: [0, -0.3, 0.36], scale: [0.5, 0.012, 0.03], color: DARK }));
  sph.dispose(); cyl.dispose(); box.dispose(); cone.dispose();
  return mergeParts(list);
}

function boneGeometry() {
  const cyl = new THREE.CylinderGeometry(0.032, 0.032, 0.84, 6, 1), sph = new THREE.SphereGeometry(0.06, 6, 4);
  const list = [part(cyl, { rot: [0, 0, Math.PI / 2] })];
  for (const sx of [-0.42, 0.42]) for (const z of [-0.035, 0.035]) list.push(part(sph, { pos: [sx, 0, z] }));
  cyl.dispose(); sph.dispose();
  return mergeParts(list);
}

// A bone between two points (used by the seated skeleton).
function boneBetween(a, b, r, color = BONE) {
  const dir = new THREE.Vector3().subVectors(b, a); const len = dir.length();
  const cyl = new THREE.CylinderGeometry(r * 0.75, r * 0.75, len, 6, 1); cyl.translate(0, len / 2, 0);
  const knob = new THREE.SphereGeometry(r * 1.45, 6, 4);
  const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const m = new THREE.Matrix4().compose(a, quat, new THREE.Vector3(1, 1, 1));
  const out = [];
  const body = part(cyl, { color }); body.applyMatrix4(m); out.push(body);
  for (const p of [a, b]) out.push(part(knob, { pos: p.toArray(), color }));
  cyl.dispose(); knob.dispose();
  return out;
}

function skeletonGeometry() {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const list = [];
  const add = (a, b, r) => list.push(...boneBetween(a, b, r));
  // spine curves back against the rail (rail behind = -z)
  const spine = [V(0, 0.2, 0), V(0, 0.34, -0.03), V(0, 0.48, -0.06), V(0, 0.62, -0.09), V(0, 0.76, -0.11), V(0, 0.9, -0.12)];
  for (let i = 0; i < spine.length - 1; i++) add(spine[i], spine[i + 1], 0.022);
  // pelvis
  add(V(-0.12, 0.17, 0.02), V(0.12, 0.17, 0.02), 0.03); add(V(-0.12, 0.17, 0.02), V(-0.07, 0.24, -0.04), 0.025); add(V(0.12, 0.17, 0.02), V(0.07, 0.24, -0.04), 0.025);
  // ribs: shrinking rings, open at the back
  const torus = new THREE.TorusGeometry(1, 0.075, 4, 12, Math.PI * 1.45);
  for (let i = 0; i < 6; i++) {
    const y = 0.42 + i * 0.065, rad = 0.095 + 0.045 * Math.sin((i / 5) * Math.PI * 0.9 + 0.5);
    list.push(part(torus, { pos: [0, y, -0.07 - i * 0.004], rot: [Math.PI / 2, 0, Math.PI * 0.275 + Math.PI / 2], scale: [rad * 1.1, rad * 0.8, rad * 1.0] }));
  }
  torus.dispose();
  add(V(0, 0.46, 0.02), V(0, 0.8, -0.0), 0.014);
  // clavicles, arms (hands resting on the knees)
  for (const s of [-1, 1]) {
    add(V(0, 0.9, -0.11), V(s * 0.17, 0.89, -0.11), 0.018);
    add(V(s * 0.17, 0.89, -0.11), V(s * 0.21, 0.62, -0.02), 0.022);
    add(V(s * 0.21, 0.62, -0.02), V(s * 0.16, 0.5, 0.36), 0.018);
    add(V(s * 0.16, 0.5, 0.36), V(s * 0.15, 0.48, 0.45), 0.012);
    // legs
    add(V(s * 0.09, 0.16, 0.0), V(s * 0.11, 0.42, 0.44), 0.03);
    add(V(s * 0.11, 0.42, 0.44), V(s * 0.12, 0.06, 0.74), 0.024);
    add(V(s * 0.12, 0.06, 0.74), V(s * 0.12, 0.04, 0.9), 0.02);
  }
  const skull = skullGeometry(); skull.applyMatrix4(new THREE.Matrix4().compose(V(0, 1.06, -0.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.28, 0, 0.08)), V(0.26, 0.26, 0.26)));
  list.push(skull);
  // tricorn: lathe crown + wide flat brim, tilted
  const crown = new THREE.CylinderGeometry(0.1, 0.13, 0.12, 12, 1), brim = new THREE.CylinderGeometry(0.27, 0.27, 0.018, 3, 1);
  const hatMatrix = new THREE.Matrix4().compose(V(0, 1.27, -0.07), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.28, 0.1, 0.08)), V(1, 1, 1));
  const c1 = part(crown, { color: [0.06, 0.04, 0.05], pos: [0, 0.03, 0] }), c2 = part(brim, { color: [0.07, 0.05, 0.06], pos: [0, -0.02, 0], rot: [0, 0.5, 0] });
  c1.applyMatrix4(hatMatrix); c2.applyMatrix4(hatMatrix); list.push(c1, c2);
  crown.dispose(); brim.dispose();
  return mergeParts(list);
}

// ---------------------------------------------------------------------------------------------
// Poly Haven model helpers
// ---------------------------------------------------------------------------------------------
const RECENTRE_MODELS = new Set(['brass_candleholders', 'dry_branches_medium_01']);
async function loadModelParts(loader, base, id) {
  const gltf = await loader.loadAsync(`${base}${MODEL_DIR}${id}/${id}_1k.gltf`);
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    let top = o; while (top.parent && top.parent !== gltf.scene) top = top.parent;
    const geometry = o.geometry.clone(); geometry.applyMatrix4(o.matrixWorld);
    // Models that hold several separate objects side by side: centre each object on its own origin.
    if (RECENTRE_MODELS.has(id)) geometry.translate(-top.position.x, -top.position.y, -top.position.z);
    parts.push({ geometry, material: o.material, name: `${o.name}|${o.material.name}`, variant: top.name });
  });
  gltf.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  return parts;
}

const boundsOf = (parts, filter = () => true) => { const b = new THREE.Box3(); for (const p of parts) if (filter(p)) { p.geometry.computeBoundingBox(); b.union(p.geometry.boundingBox); } return b; };

function propMaterial(source, ctx, key) {
  const m = source.clone();
  m.name = `${source.name}:halloween`;
  if (m.transmission !== undefined) m.transmission = 0;
  return patchDeco(m, ctx, { key: `prop:${key}:${m.name}` });
}

function glowSprites(ctx, items, name) {
  // items: { x, y, z, size, intensity, color:[r,g,b], phase, start }
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, ctx.spriteMaterial, items.length);
  const a = new Float32Array(items.length * 4), c = new Float32Array(items.length * 3);
  items.forEach((it, i) => {
    mesh.setMatrixAt(i, _m.makeTranslation(it.x, it.y, it.z));
    a.set([it.size, it.intensity, it.phase ?? 0, it.start ?? 0], i * 4); c.set(it.color, i * 3);
  });
  geometry.setAttribute('aSprite', new THREE.InstancedBufferAttribute(a, 4));
  geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(c, 3));
  mesh.name = name; mesh.frustumCulled = false; mesh.renderOrder = 6;
  return mesh;
}

function createSpriteMaterial(ctx) {
  return new THREE.ShaderMaterial({
    uniforms: { uHwAmt: ctx.U.amt, uHwTime: ctx.U.time, uHwNight: ctx.U.night, uHwFlash: ctx.U.flash },
    vertexShader: /* glsl */`
      attribute vec4 aSprite; attribute vec3 aColor;
      uniform float uHwAmt; uniform float uHwTime; uniform float uHwNight; uniform float uHwFlash;
      varying vec2 vUv; varying vec3 vCol; varying float vI;
      void main() {
        float s = smoothstep(aSprite.w, aSprite.w + 0.28, uHwAmt);
        float fl = 1.0 + 0.16 * sin(uHwTime * 9.0 + aSprite.z * 37.0) + 0.09 * sin(uHwTime * 23.0 + aSprite.z * 91.0) + 0.06 * sin(uHwTime * 3.1 + aSprite.z * 11.0);
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * aSprite.x * s;
        mv.z += aSprite.x * 0.1;
        vUv = position.xy * 2.0; vCol = aColor;
        vI = aSprite.y * fl * s * (0.12 + 0.88 * uHwNight) * (1.0 + uHwFlash * 0.2) * smoothstep(aSprite.x * 0.2, aSprite.x * 0.9, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec3 vCol; varying float vI;
      void main() {
        float r = length(vUv); if (r >= 1.0) discard;
        float g = pow(1.0 - r, 2.4); float core = pow(1.0 - r, 9.0);
        vec3 c = vCol * (g * 0.8 + core * 1.1) * vI;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Decoration builders
// ---------------------------------------------------------------------------------------------
const PUMPKIN_TINTS = [0xe9741a, 0xd95a0c, 0xf29a2e, 0xc9480b, 0xe36f14, 0xf0861c, 0xd0a45a, 0x7f9b3b, 0x5d3a78];
const PUMPKIN_WEIGHTS = [4, 3, 3, 2, 3, 2, 0.5, 0.5, 0.5];
function pickTint(rand) {
  let total = 0; for (const w of PUMPKIN_WEIGHTS) total += w;
  let r = rand() * total; for (let i = 0; i < PUMPKIN_TINTS.length; i++) { r -= PUMPKIN_WEIGHTS[i]; if (r <= 0) return PUMPKIN_TINTS[i]; }
  return PUMPKIN_TINTS[0];
}

function pumpkinMaterial(ctx) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  return patchDeco(m, ctx, {
    key: 'pumpkin',
    uniforms: () => ({ tFaces: { value: ctx.faceTex } }),
    vertexPars: 'attribute float aFace; attribute float aPhase; attribute float aGlow; varying vec3 vPk; varying float vFace; varying float vPhase; varying float vGlow;',
    vertexBody: 'vPk = vec3(position.xy, normal.z); vFace = aFace; vPhase = aPhase; vGlow = aGlow;',
    fragPars: 'uniform sampler2D tFaces; varying vec3 vPk; varying float vFace; varying float vPhase; varying float vGlow;',
    fragColor: `
      float hwFront = smoothstep(0.2, 0.45, vPk.z) * step(-0.5, vFace);
      vec2 hwFuv = vec2((max(vFace, 0.0) + clamp(0.5 + vPk.x * 1.12, 0.0, 1.0)) * 0.25, clamp(0.5 + vPk.y * 1.15 + 0.02, 0.0, 1.0));
      float hwCarve = texture(tFaces, hwFuv).r * hwFront;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.3, 0.03), hwCarve);`,
    fragEmissive: `
      float hwFl = 0.82 + 0.12 * sin(uHwTime * 8.3 + vPhase * 40.0) + 0.06 * sin(uHwTime * 21.0 + vPhase * 77.0) + 0.05 * sin(uHwTime * 2.3 + vPhase * 9.0);
      totalEmissiveRadiance += vec3(1.0, 0.46, 0.05) * hwCarve * vGlow * (0.45 + 3.6 * uHwNight) * hwFl;
      totalEmissiveRadiance += diffuseColor.rgb * vGlow * 0.06 * uHwNight * hwFront;`,
  });
}

function ironMaterial(ctx) {
  return patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.65 }), ctx, { key: 'iron', pivot: true });
}

function boneMaterial(ctx) {
  return patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }), ctx, { key: 'bone', pivot: true });
}

function boneInstanceMaterial(ctx) {
  return patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }), ctx, { key: 'boneInst' });
}

// Bare, twisted branches growing from each planter trunk; one twig + string per hanging pumpkin.
function deadTreeGeometry(ctx, trees, rand) {
  const merger = new Merger();
  const bark = (k) => [0.075 + k * 0.03, 0.055 + k * 0.02, 0.05 + k * 0.02];
  const tube = (curve, r0, r1, start, pivot, radial = 5, seg = 8) => {
    const g = new THREE.TubeGeometry(curve, seg, 1, radial, false); // radius baked below
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      const ring = Math.floor(i / (radial + 1)); const t = ring / seg; const r = r0 + (r1 - r0) * t;
      const c = curve.getPointAt(t);
      pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * r, c.y + (pos.getY(i) - c.y) * r, c.z + (pos.getZ(i) - c.z) * r);
    }
    g.computeVertexNormals();
    merger.add(g, { color: bark(rand()), pivot, start });
    g.dispose();
  };
  const twine = new THREE.CylinderGeometry(0.008, 0.008, 1, 4, 1); twine.translate(0, 0.5, 0);
  for (const tree of trees) {
    const T = new THREE.Vector3(tree.x, tree.top, tree.z);
    const pivot = T.toArray(); const start = 0.08 + rand() * 0.2;
    const primaries = [];
    const count = 7;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + rand() * 0.6, reach = 0.9 + rand() * 0.9, rise = 0.6 + rand() * 1.1;
      const pts = [T.clone(), T.clone().add(new THREE.Vector3(Math.cos(a) * reach * 0.25, rise * 0.4, Math.sin(a) * reach * 0.25)),
        T.clone().add(new THREE.Vector3(Math.cos(a + 0.4) * reach * 0.65, rise * 0.75, Math.sin(a + 0.4) * reach * 0.65)),
        T.clone().add(new THREE.Vector3(Math.cos(a - 0.2) * reach, rise, Math.sin(a - 0.2) * reach))];
      const curve = new THREE.CatmullRomCurve3(pts);
      tube(curve, 0.075, 0.018, start, pivot, 5, 9);
      primaries.push(curve);
      // a couple of bare twigs
      for (let j = 0; j < 2; j++) {
        const base = curve.getPointAt(0.45 + rand() * 0.45);
        const dir = new THREE.Vector3(rand() - 0.5, 0.35 + rand() * 0.5, rand() - 0.5).normalize().multiplyScalar(0.35 + rand() * 0.45);
        const mid = base.clone().add(dir.clone().multiplyScalar(0.5)).add(new THREE.Vector3(rand() * 0.1 - 0.05, 0.05, rand() * 0.1 - 0.05));
        tube(new THREE.CatmullRomCurve3([base, mid, base.clone().add(dir)]), 0.026, 0.006, start + 0.05, pivot, 4, 4);
      }
    }
    for (const f of tree.fruit) {
      const a = new THREE.Vector3(f.x, f.y + f.size * 0.55 + 0.3 + rand() * 0.25, f.z);
      let best = null, bd = 1e9;
      for (const c of primaries) for (let i = 3; i <= 12; i++) { const p = c.getPointAt(i / 12); const d = p.distanceTo(a); if (d < bd) { bd = d; best = p; } }
      const bend = best.clone().lerp(a, 0.5).add(new THREE.Vector3(rand() * 0.1 - 0.05, 0.04, rand() * 0.1 - 0.05));
      tube(new THREE.CatmullRomCurve3([best, bend, a]), 0.016, 0.01, 0.1 + f.start * 0.8, pivot, 4, 3);
      const top = f.y + f.size * 0.5, len = a.y - top;
      merger.add(twine, { matrix: _m.compose(_p.set(a.x, top, a.z), _q.identity(), _s.set(1, len, 1)).clone(), color: [0.12, 0.09, 0.06], pivot, start: f.start });
    }
  }
  twine.dispose();
  return merger.build();
}

function addPumpkins(ctx, spots) {
  const hi = pumpkinGeometry(20, 12), lo = pumpkinGeometry(12, 7);
  const mat = pumpkinMaterial(ctx); ctx.own.push(mat, hi, lo);
  const make = (geometry, list, name) => {
    if (!list.length) return;
    const mesh = instanced(geometry, mat, list, name);
    const n = list.length, face = new Float32Array(n), phase = new Float32Array(n), glow = new Float32Array(n);
    list.forEach((it, i) => { face[i] = it.face; phase[i] = it.phase; glow[i] = it.glow; });
    geometry.setAttribute('aFace', new THREE.InstancedBufferAttribute(face, 1));
    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geometry.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1));
    ctx.group.add(mesh); ctx.counts[name] = n;
  };
  make(hi, spots.filter((s) => !s.low), 'pumpkins');
  make(lo, spots.filter((s) => s.low), 'hangingPumpkins');
}

function lanternSet(ctx, parts, matrices, starts, name, glassTone) {
  const meshes = [];
  const glass = parts.filter((p) => /glass/i.test(p.name));
  const solid = parts.filter((p) => !/glass/i.test(p.name));
  const matCache = new Map();
  const matFor = (p) => {
    if (matCache.has(p.material.uuid)) return matCache.get(p.material.uuid);
    const m = propMaterial(p.material, ctx, `${name}`);
    if (/glass/i.test(p.name)) {
      m.transmission = 0; m.transparent = true; m.opacity = 0.9; m.depthWrite = false; m.map = null; m.metalnessMap = null; m.roughnessMap = null; m.normalMap = null;
      m.color.set(0xffa530); m.emissive.set(glassTone); m.emissiveIntensity = 0.1; m.roughness = 0.2; m.metalness = 0; ctx.glass.push(m);
    }
    ctx.own.push(m); matCache.set(p.material.uuid, m); return m;
  };
  for (const p of [...solid, ...glass]) {
    const items = matrices.map((m, i) => ({ matrix: m, start: starts[i] }));
    const mesh = instanced(p.geometry.clone(), matFor(p), items, `${name}:${p.name}`);
    meshes.push(mesh); ctx.group.add(mesh);
    if (/glass/i.test(p.name)) mesh.renderOrder = 4;
  }
  return meshes;
}

const placeAt = (x, y, z, { ry = 0, rx = 0, rz = 0, s = 1, start = 0.3, quat = null } = {}) => ({
  matrix: quat ? new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), quat, new THREE.Vector3(s, s, s)) : compose(x, y, z, ry, s, rx, rz).clone(),
  start, x, y, z, s,
});

function propInstances(ctx, parts, placements, name, filter = null) {
  const meshes = []; const cache = new Map();
  for (const p of parts) {
    if (/flame/i.test(p.name) || (filter && !filter(p))) continue;
    let mat = cache.get(p.material.uuid);
    if (!mat) { mat = propMaterial(p.material, ctx, name); cache.set(p.material.uuid, mat); ctx.own.push(mat); }
    const mesh = instanced(p.geometry.clone(), mat, placements, `${name}:${p.name}`);
    ctx.group.add(mesh); meshes.push(mesh);
  }
  return meshes;
}

function withAppear(geometry, pivot, start) {
  const n = geometry.attributes.position.count;
  const pv = new Float32Array(n * 3), st = new Float32Array(n);
  for (let i = 0; i < n; i++) { pv.set(pivot, i * 3); st[i] = start; }
  geometry.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
  geometry.setAttribute('aStart', new THREE.BufferAttribute(st, 1));
  return geometry;
}

function flameCentres(parts, variant) {
  const out = [];
  for (const p of parts) {
    if (!/flame/i.test(p.name) || (variant && p.variant !== variant)) continue;
    const g = p.geometry.clone();
    if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    for (const c of withShrinkAttributes(g, 1).components) out.push(c.centre.clone());
    g.dispose();
  }
  return out;
}

// y-up quaternion for a blade lying on a wall: thin axis -> wall normal (+z), long axis tilted by `tilt` in the wall plane.
const wallQuat = (tilt) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));

function buildProps(ctx, { glow, foot, tmpRail }) {
  const { group, rand, models } = ctx;
  const WARM = [1, 0.66, 0.26];
  const GREEN = [0.4, 1, 0.35];


  // ---- Poly Haven candle holders (flames are sprites) -----------------------------------------------
  const cand = models.brass_candleholders;
  const variantOf = (p) => p.variant;
  const candelabra = [placeAt(1.75, 4.2, -8.35, { s: 1.5, ry: 0.0, start: 0.5 })];
  const triples = [placeAt(-1.75, 4.2, -8.35, { s: 1.9, start: 0.45 }), placeAt(-1.15, 0.0, -7.5, { s: 1.6, start: 0.4 }), placeAt(1.15, 0.0, -7.5, { s: 1.6, start: 0.42 }), placeAt(-3.45, 0.78, -5.9, { s: 1.4, start: 0.5 }), placeAt(3.45, 0.78, -5.9, { s: 1.4, start: 0.52 })];
  railAt(1.8, tmpRail); const sx = tmpRail.x - 0.65;
  const singles = [placeAt(sx, 0, 1.9, { s: 2.1, start: 0.35 }), placeAt(-sx, 0, -1.4, { s: 2.1, start: 0.37 }), placeAt(0.45, 1.17, -2.95, { s: 1.8, start: 0.4 }), placeAt(-0.5, 1.17, -2.98, { s: 1.8, start: 0.42 }), placeAt(-sx + 0.3, 0, 8.6, { s: 2.1, start: 0.4 }), placeAt(sx - 0.2, 0, 7.0, { s: 2.1, start: 0.38 })];
  const candleSets = [['brass_candleholder_03', candelabra], ['brass_candleholder_02', triples], ['brass_candleholder_01', singles]];
  for (const [variant, list] of candleSets) {
    propInstances(ctx, cand, list, `candle:${variant}`, (p) => variantOf(p) === variant);
    const flames = flameCentres(cand, variant);
    for (const pl of list) {
      for (const f of flames) {
        const wx = pl.x + f.x * pl.s, wy = pl.y + (f.y + 0.012) * pl.s, wz = pl.z + f.z * pl.s;
        glow(wx, wy, wz, 0.5 * Math.max(1, pl.s * 0.9), 1.1, [1, 0.62, 0.2], pl.start, rand() * 6.3);
      }
      foot(`candle ${variant}`, pl.x, pl.z, 0.2 * pl.s, pl.y, pl.y + 0.8 * pl.s);
    }
  }
  ctx.counts.candleHolders = candelabra.length + triples.length + singles.length;

  // ---- statue above the cabin door, flanked by candelabra -------------------------------------------
  propInstances(ctx, models.gothic_statue, [placeAt(0, 4.2, -8.95, { s: 1.2, ry: 0, start: 0.35 })], 'statue');
  foot('statue', 0, -8.95, 0.7, 4.2, 6.1);
  ctx.counts.statues = 1;

  // ---- sabers crossed over the door with a skull ----------------------------------------------------
  const sabers = [0.72, -0.72].map((tilt) => placeAt(0 + Math.sin(tilt) * 0.33 * 0.95, 3.62 - Math.cos(tilt) * 0.33 * 0.95, -7.66, { s: 0.95, quat: wallQuat(tilt), start: 0.5 }));
  propInstances(ctx, models.wooden_handle_saber, sabers, 'saber');
  ctx.counts.sabers = sabers.length;

  // ---- brooms leaning on the rail --------------------------------------------------------------------
  const brooms = [];
  for (const [sd, z] of [[1, 2.55], [-1, -3.3]]) {
    railAt(z, tmpRail);
    brooms.push(placeAt(sd * (tmpRail.x - 0.92), 0.14, z, { s: 1.15, rz: -sd * 0.33, ry: 0, start: 0.55 }));
    foot('broom', sd * (tmpRail.x - 0.75), z, 0.4, 0, 1.6);
  }
  propInstances(ctx, models.wooden_broom, brooms, 'broom');
  ctx.counts.brooms = brooms.length;

  // ---- cauldrons ----------------------------------------------------------------------------------------
  const pots = [placeAt(-3.0, 0, 9.6, { s: 3.0, start: 0.3 }), placeAt(3.3, 0, 10.4, { s: 2.6, start: 0.32 })];
  propInstances(ctx, models.brass_pot_01, pots, 'cauldron');
  const liquid = new Merger();
  const disc = new THREE.CircleGeometry(0.128, 18); disc.rotateX(-Math.PI / 2);
  for (const pl of pots) {
    liquid.add(disc, { matrix: compose(pl.x, pl.y + 0.243 * pl.s, pl.z, 0, pl.s).clone(), color: [0.2, 0.9, 0.12], pivot: [pl.x, pl.y, pl.z], start: pl.start });
    glow(pl.x, pl.y + 0.34 * pl.s, pl.z, 1.05 * pl.s, 0.8, GREEN, pl.start, rand() * 6);
    foot('cauldron', pl.x, pl.z, 0.16 * pl.s, 0, 0.3 * pl.s);
  }
  disc.dispose();
  const liquidGeometry = liquid.build();
  const liquidMaterial = patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2, emissive: 0x2cff22, emissiveIntensity: 1 }), ctx, {
    key: 'liquid', pivot: true,
    fragEmissive: 'totalEmissiveRadiance *= (0.35 + 1.6 * uHwNight) * (0.85 + 0.15 * sin(uHwTime * 3.0 + vViewPosition.x * 4.0));',
  });
  const liquidMesh = new THREE.Mesh(liquidGeometry, liquidMaterial); liquidMesh.name = 'Cauldron brew'; group.add(liquidMesh);
  ctx.own.push(liquidGeometry, liquidMaterial); ctx.counts.cauldrons = pots.length;

  // ---- scattered dry branches ---------------------------------------------------------------------
  const branchVariants = [...new Set(models.dry_branches_medium_01.map((p) => p.variant))];
  const branchSpots = [[5.6, 0.04, -3.6], [-5.5, 0.04, 3.9], [5.4, 0.04, 8.1], [-2.4, 0.04, 11.6]];
  const branchPlacements = branchVariants.map(() => []);
  branchSpots.forEach(([x, y, z], i) => { const k = i % branchVariants.length; const ry = (rand() - 0.5) * 3; branchPlacements[k].push(placeAt(x, y, z, { ry, s: 1.2, start: 0.5 + rand() * 0.2 })); foot('branch', x, z, 0.5, 0, 0.3); });
  branchVariants.forEach((v, k) => { if (branchPlacements[k].length) propInstances(ctx, models.dry_branches_medium_01, branchPlacements[k], `branch:${v}`, (p) => p.variant === v); });
  ctx.counts.branches = branchSpots.length;

  // ---- Lantern_01 hurricane lamps on the foredeck rail ------------------------------------------------
  const hurricane = [];
  railAt(8.9, tmpRail); hurricane.push(placeAt(-(tmpRail.x - 0.1), tmpRail.top + 0.03, 8.9, { s: 2.2, start: 0.32 }));
  const lamp = propInstances(ctx, models.Lantern_01, hurricane, 'hurricane lamp');
  for (const m of lamp) if (/glass/i.test(m.name)) { m.material.transmission = 0; m.material.transparent = true; m.material.opacity = 0.8; m.material.map = null; m.material.metalnessMap = null; m.material.roughnessMap = null; m.material.normalMap = null; m.material.color.set(0xffa030); m.material.emissive.set(0xff8a1f); m.material.depthWrite = false; ctx.glass.push(m.material); }
  for (const pl of hurricane) { glow(pl.x, pl.y + 0.1 * pl.s, pl.z, 1.8, 0.9, WARM, pl.start); foot('hurricane lamp', pl.x, pl.z, 0.15 * pl.s, pl.y, pl.y + 0.3 * pl.s); }
  ctx.counts.hurricaneLamps = hurricane.length;

  // ---- skulls, bones, skull-and-crossbones plaques, seated skeleton --------------------------------
  const skullMat = boneInstanceMaterial(ctx); ctx.own.push(skullMat);
  const skulls = [];
  const skull = (x, y, z, s, ry, { start = 0.4 + rand() * 0.3, rx = 0, color = null } = {}) => { skulls.push({ matrix: compose(x, y, z, ry, s, rx).clone(), start, color }); foot('skull', x, z, s * 0.4, y, y + s * 0.5); };
  skull(0.2, 1.17 + 0.14, -2.7, 0.3, 0.25); skull(-0.28, 1.17 + 0.14, -2.72, 0.26, -0.2);
  for (const [cx, cz] of [[-4.2, -5.2], [4.2, -5.2]]) skull(cx + 0.55, 0.84, cz + 0.55, 0.28, cx > 0 ? 0.6 : -0.6);
  skull(-3.5 + 0.5, 4.86 + 0.1, -12.5 + 0.6, 0.28, 0.4);
  skull(0, 3.62, -7.55, 0.3, 0, { start: 0.5 });
  for (const [sd, z] of [[1, -4.0], [-1, -0.9], [1, 2.0], [-1, 4.9], [1, 7.4], [-1, 9.8], [1, 9.8]]) { railAt(z, tmpRail); skull(sd * tmpRail.x, tmpRail.top + 0.14, z, 0.3, sd > 0 ? 0.5 : Math.PI / 2 - 0.2); }
  skull(-1.1, 0.14, 9.6 + 1.2, 0.34, 0.5); skull(1.2, 0.14, 10.4 + 1.4, 0.3, -0.4);
  const skullGeo = skullGeometry();
  const skullMesh = instanced(skullGeo, skullMat, skulls, 'Skulls'); group.add(skullMesh); ctx.own.push(skullGeo); ctx.counts.skulls = skulls.length;

  const plaqueGeo = (() => {
    const list = [];
    const bone = boneGeometry();
    for (const a of [0.7, -0.7]) list.push(Object.assign(part(bone, { rot: [0, 0, a], scale: [1.1, 1.1, 1.1], pos: [0, -0.04, -0.02] })));
    const sk = skullGeometry(); sk.applyMatrix4(new THREE.Matrix4().makeScale(0.62, 0.62, 0.62).setPosition(0, 0.16, 0.06));
    list.push(sk); bone.dispose();
    return mergeParts(list);
  })();
  const plaques = [];
  const RED_Z = [-6, -4, -2, 0, 2, 4, 6, 8], RED_X = [6.6, 6.9, 7.0, 7.0, 6.9, 6.8, 6.5, 6.1];
  const hullX = (z) => { let i = 0; while (i < RED_Z.length - 2 && z > RED_Z[i + 1]) i++; const t = (z - RED_Z[i]) / (RED_Z[i + 1] - RED_Z[i]); return RED_X[i] + (RED_X[i + 1] - RED_X[i]) * t; };
  for (const sd of [1, -1]) for (const z of [-3.6, 1.2, 5.6]) {
    const slope = (hullX(z + 0.3) - hullX(z - 0.3)) / 0.6;
    plaques.push({ matrix: compose(sd * (hullX(z) + 0.06), 0.5, z, Math.atan2(sd, -slope), 0.62).clone(), start: 0.55 + rand() * 0.2 });
  }
  const plaqueMesh = instanced(plaqueGeo, skullMat, plaques, 'Skull and crossbones plaques'); group.add(plaqueMesh); ctx.own.push(plaqueGeo); ctx.counts.plaques = plaques.length;

  const bones = [];
  const lay = (x, y, z, ry, s = 0.55) => { bones.push({ matrix: compose(x, y, z, ry, s, 0, 0).clone(), start: 0.5 + rand() * 0.3 }); foot('bone', x, z, s * 0.45, y, y + 0.1); };
  for (const [cx, cz] of [[-4.2, -5.2], [4.2, -5.2]]) { lay(cx - 0.45, 0.78, cz + 0.5, 0.4, 0.4); lay(cx + 0.15, 0.78, cz + 0.62, 1.9, 0.35); }
  for (const [x, z, ry] of [[5.2, 0.8, 0.8], [-5.2, -0.3, -0.5], [5.4, 6.4, 0.3], [-5.0, 6.4, 1.2], [-2.6, 9.0, 2.2], [3.0, 9.4, -0.6], [0.25, -4.95, 0.3], [-5.3, 9.0, 0.2]]) { lay(x, 0.04, z, ry); lay(x + 0.18, 0.04, z + 0.2, ry + 1.4, 0.45); }
  const boneGeo = boneGeometry();
  const boneMesh = instanced(boneGeo, skullMat, bones, 'Bones'); group.add(boneMesh); ctx.own.push(boneGeo); ctx.counts.bones = bones.length;

  // seated skeleton against the port rail, hat and all
  railAt(-3.0, tmpRail);
  const skelS = 1.35, skelX = -(tmpRail.x - 0.5);
  const skelGeo = skeletonGeometry();
  skelGeo.applyMatrix4(compose(skelX, 0, -3.0, Math.PI / 2 + 0.12, skelS).clone());
  withAppear(skelGeo, [skelX, 0.3, -3.0], 0.45);
  const skelMesh = new THREE.Mesh(skelGeo, boneMaterial(ctx)); skelMesh.name = 'Seated pirate skeleton'; group.add(skelMesh);
  ctx.own.push(skelGeo, skelMesh.material); ctx.counts.skeletons = 1;
  foot('skeleton', skelX + 0.55, -3.0, 0.9, 0, 1.9);
}

function greyscaleTexture(source, { contrast = 1.15, lift = 6 } = {}) {
  const img = source.image;
  const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
  const g = canvas.getContext('2d'); g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    let l = 0.3 * data.data[i] + 0.59 * data.data[i + 1] + 0.11 * data.data[i + 2];
    l = Math.max(0, Math.min(255, (l - 128) * contrast + 128 + lift));
    data.data[i] = data.data[i + 1] = data.data[i + 2] = l;
  }
  g.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = source.anisotropy;
  return t;
}

function clothMaterial(ctx, { map, normalMap = null, mode = 'hang', tatter = 0.9, key = '' }) {
  const m = new THREE.MeshStandardMaterial({ map, normalMap, vertexColors: true, side: THREE.DoubleSide, roughness: 0.95 });
  const flag = mode === 'flag';
  return patchDeco(m, ctx, {
    key: `cloth:${mode}:${key}`, pivot: true,
    vertexPars: 'varying vec2 vCl;',
    vertexBody: flag
      ? 'vCl = uv; transformed += normal * sin(uHwTime * 3.1 + uv.x * 7.0 + position.y * 1.3) * 0.2 * uv.x * hwS; transformed.y += sin(uHwTime * 2.3 + uv.x * 5.0) * 0.06 * uv.x * hwS;'
      : 'vCl = uv; transformed += normal * sin(uHwTime * 2.4 + position.x * 2.1 + position.z * 1.9 + position.y * 0.8) * 0.07 * uv.y * hwS;',
    fragPars: 'varying vec2 vCl;',
    fragColor: `
      float hwTn = hwF2(vCl * vec2(6.0, 11.0) + 3.0);
      if (hwTn < smoothstep(${flag ? '0.72, 1.0, vCl.x' : '0.5, 1.0, vCl.y'}) * ${tatter.toFixed(3)}) discard;
      diffuseColor.rgb *= 0.78 + 0.5 * hwF2(vCl * 3.0 + 7.0);`,
  });
}

const tri = (a, b, c, ua, ub, uc) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([...ua, ...ub, ...uc], 2));
  g.setIndex([0, 1, 2]); g.computeVertexNormals();
  return g;
};

function ragGeometry(w, len, rand) {
  const rows = 6, g = new THREE.PlaneGeometry(w, len, 2, rows);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const v = 1 - (uv.getY(i)); // 0 at the top (attached), 1 at the tip
    const taper = 1 - 0.35 * v + (rand() - 0.5) * 0.12 * v;
    pos.setX(i, pos.getX(i) * taper); pos.setY(i, pos.getY(i) - len / 2 + (rand() - 0.5) * 0.05 * len * v);
    uv.setY(i, v);
  }
  g.computeVertexNormals();
  return g;
}

function bannerTexture(fabric) {
  return canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#1a1020'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c9560b'; g.fillRect(0, 0, w, 26); g.fillRect(0, h - 26, w, 26);
    g.strokeStyle = '#ff8a1f'; g.lineWidth = 3; g.lineCap = 'round';
    const cx = w / 2, cy = 150;
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * 110, cy + Math.sin(a) * 110); g.stroke(); }
    for (let r = 28; r <= 110; r += 20) { g.beginPath(); for (let i = 0; i <= 12; i++) { const a = (i / 12) * TAU; const rr = r * (0.92 + 0.08 * Math.sin(i * 2.7)); const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr; if (i) g.lineTo(px, py); else g.moveTo(px, py); } g.stroke(); }
    g.fillStyle = '#0a0610'; g.beginPath(); g.ellipse(cx, 330, 26, 34, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(cx, 292, 14, 14, 0, 0, TAU); g.fill();
    g.strokeStyle = '#0a0610'; g.lineWidth = 6; for (let i = 0; i < 4; i++) for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * 18, 316 + i * 8); g.quadraticCurveTo(cx + s * 56, 296 + i * 22, cx + s * 70, 340 + i * 30); g.stroke(); }
    g.fillStyle = '#ffa63a'; g.fillRect(cx - 9, 288, 6, 6); g.fillRect(cx + 4, 288, 6, 6);
    g.fillStyle = '#e7dfc4'; g.beginPath(); g.ellipse(cx, 450, 40, 30, 0, 0, TAU); g.fill();
    g.fillStyle = '#1a1020'; g.beginPath(); g.ellipse(cx - 14, 446, 8, 10, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(cx + 14, 446, 8, 10, 0, 0, TAU); g.fill();
    // woven velour grain over the printed art
    g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.6; g.drawImage(fabric, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }, { srgb: true });
}

function ravenGeometry() {
  const sph = new THREE.SphereGeometry(0.5, 10, 8), cone = new THREE.ConeGeometry(0.05, 0.2, 6), box = new THREE.BoxGeometry(1, 1, 1), cyl = new THREE.CylinderGeometry(0.012, 0.012, 0.14, 4);
  const BLK = [0.035, 0.035, 0.05], BLUE = [0.07, 0.085, 0.14], BEAK = [0.32, 0.27, 0.22], EYE = [0.95, 0.5, 0.1];
  const list = [
    part(sph, { pos: [0, 0.2, 0], scale: [0.3, 0.32, 0.56], color: BLK }),
    part(sph, { pos: [0, 0.36, 0.24], scale: [0.2, 0.2, 0.22], color: BLK }),
    part(cone, { pos: [0, 0.34, 0.42], rot: [Math.PI / 2, 0, 0], color: BEAK }),
    part(box, { pos: [0, 0.17, -0.38], rot: [-0.25, 0, 0], scale: [0.16, 0.02, 0.34], color: BLUE }),
  ];
  for (const s of [-1, 1]) {
    list.push(part(sph, { pos: [s * 0.08, 0.39, 0.33], scale: [0.05, 0.05, 0.05], color: EYE }));
    list.push(part(sph, { pos: [s * 0.15, 0.22, -0.04], rot: [0.1, 0, s * 0.15], scale: [0.08, 0.24, 0.5], color: BLUE }));
    list.push(part(cyl, { pos: [s * 0.06, 0.05, 0.04], color: BEAK }));
  }
  sph.dispose(); cone.dispose(); box.dispose(); cyl.dispose();
  return mergeParts(list);
}

function catGeometry() {
  const sph = new THREE.SphereGeometry(0.5, 12, 8), cone = new THREE.ConeGeometry(0.5, 1, 4), cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const K = [0.012, 0.012, 0.016];
  const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.05, 0.05, -0.16), new THREE.Vector3(0.22, 0.03, -0.14), new THREE.Vector3(0.3, 0.14, -0.04), new THREE.Vector3(0.28, 0.34, -0.1)]), 12, 0.03, 5, false);
  const list = [
    part(sph, { pos: [0, 0.22, -0.05], scale: [0.34, 0.44, 0.32], color: K }),
    part(sph, { pos: [0.1, 0.12, -0.1], scale: [0.2, 0.22, 0.26], color: K }), part(sph, { pos: [-0.1, 0.12, -0.1], scale: [0.2, 0.22, 0.26], color: K }),
    part(sph, { pos: [0, 0.34, 0.06], scale: [0.22, 0.24, 0.18], color: K }),
    part(sph, { pos: [0, 0.52, 0.07], scale: [0.22, 0.2, 0.2], color: K }),
    part(cone, { pos: [0.065, 0.64, 0.05], rot: [0, 0, -0.2], scale: [0.09, 0.13, 0.05], color: K }), part(cone, { pos: [-0.065, 0.64, 0.05], rot: [0, 0, 0.2], scale: [0.09, 0.13, 0.05], color: K }),
    part(cyl, { pos: [0.06, 0.12, 0.12], scale: [0.07, 0.24, 0.07], color: K }), part(cyl, { pos: [-0.06, 0.12, 0.12], scale: [0.07, 0.24, 0.07], color: K }),
    part(tail, { color: K }),
  ];
  sph.dispose(); cone.dispose(); cyl.dispose(); tail.dispose();
  return mergeParts(list);
}

function batGeometry() {
  const parts = [];
  const addWeight = (g, v) => { g.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1)); return g; };
  const sph = new THREE.SphereGeometry(0.5, 8, 6), cone = new THREE.ConeGeometry(0.5, 1, 4);
  const solid = (geo, opts) => addWeight(part(geo, opts), 0);
  parts.push(solid(sph, { pos: [0, 0, 0], scale: [0.09, 0.08, 0.17], color: [1, 1, 1] }), solid(sph, { pos: [0, 0.012, 0.11], scale: [0.07, 0.065, 0.07], color: [1, 1, 1] }));
  for (const s of [-1, 1]) parts.push(solid(cone, { pos: [s * 0.022, 0.065, 0.12], scale: [0.025, 0.05, 0.015], color: [1, 1, 1] }));
  // wings: leading edge A, trailing edge B
  const A = [[0.03, 0, 0.06], [0.16, 0.035, 0.09], [0.3, 0.025, 0.1], [0.45, -0.02, 0.05]], B = [[0.03, 0, -0.07], [0.15, 0.0, -0.06], [0.29, -0.02, -0.03], [0.45, -0.02, 0.05]];
  for (const s of [-1, 1]) {
    const pos = [], wing = [], idx = [];
    for (let i = 0; i < 4; i++) for (const P of [A, B]) { pos.push(s * P[i][0], P[i][1], P[i][2]); wing.push(P[i][0] / 0.45); }
    for (let i = 0; i < 3; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
    g.setIndex(idx); g.computeVertexNormals();
    const n = g.attributes.position.count; g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    parts.push(g);
  }
  sph.dispose(); cone.dispose();
  return mergeParts(parts);
}

function ghostGeometry() {
  const rings = 22, seg = 22, H = 1.3;
  const pos = [], wave = [], idx = [];
  for (let j = 0; j <= rings; j++) {
    const y = (j / rings) * H;
    let r;
    if (y > 0.92) { const t = (y - 0.92) / (H - 0.92); r = 0.27 * Math.sqrt(Math.max(0, 1 - t * t)); } else { r = 0.27 + 0.2 * Math.pow(1 - y / 0.92, 1.5); }
    for (let i = 0; i <= seg; i++) { const a = (i / seg) * TAU; pos.push(Math.cos(a) * r, y, Math.sin(a) * r); wave.push(Math.pow(1 - y / H, 2)); }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { const a = j * (seg + 1) + i, b = a + seg + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function ghostMaterial(ctx) {
  return new THREE.ShaderMaterial({
    uniforms: { uHwAmt: ctx.U.amt, uHwTime: ctx.U.time, uHwNight: ctx.U.night, uHwFlash: ctx.U.flash },
    vertexShader: /* glsl */`
      attribute float aStart; attribute float aWave;
      uniform float uHwAmt; uniform float uHwTime;
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        float s = smoothstep(aStart, aStart + 0.28, uHwAmt);
        vec3 p = position; float ang = atan(p.z, p.x);
        float seed = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
        p.xz *= 1.0 + 0.12 * aWave * sin(ang * 5.0 + uHwTime * 2.2 + seed);
        p.y += 0.05 * aWave * sin(ang * 3.0 - uHwTime * 1.7 + seed);
        vP = position; p *= s;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uHwAmt; uniform float uHwNight; uniform float uHwTime;
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        float vis = uHwAmt * (0.05 + 0.95 * uHwNight);
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.5);
        vec3 col = mix(vec3(0.5, 0.72, 0.85), vec3(0.88, 1.0, 1.0), fres);
        float face = step(0.0, vP.z) * smoothstep(0.1, 0.35, vP.z);
        float eyeL = smoothstep(0.075, 0.04, length((vP.xy - vec2(-0.1, 1.02)) * vec2(1.0, 0.75)));
        float eyeR = smoothstep(0.075, 0.04, length((vP.xy - vec2(0.1, 1.02)) * vec2(1.0, 0.75)));
        float mouth = smoothstep(0.07, 0.04, length((vP.xy - vec2(0.0, 0.84)) * vec2(1.0, 0.55)));
        float hole = clamp(eyeL + eyeR + mouth, 0.0, 1.0) * face;
        float a = (0.1 + 0.38 * fres) * (0.85 + 0.15 * sin(uHwTime * 1.3 + vP.y * 4.0));
        a = mix(a, 0.92, hole) * vis;
        col = mix(col, vec3(0.01, 0.02, 0.05), hole);
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

function mistMaterial(ctx, texture) {
  return new THREE.ShaderMaterial({
    uniforms: { uHwAmt: ctx.U.amt, uHwTime: ctx.U.time, uHwNight: ctx.U.night, tMist: { value: texture } },
    vertexShader: /* glsl */`
      attribute vec4 aMist; uniform float uHwAmt;
      varying vec2 vUv; varying vec4 vM; varying float vDist;
      void main() {
        vUv = uv; vM = aMist;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vDist = -mv.z; gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uHwAmt; uniform float uHwTime; uniform float uHwNight; uniform sampler2D tMist;
      varying vec2 vUv; varying vec4 vM; varying float vDist;
      void main() {
        vec2 q = vUv * vec2(3.0, 5.0);
        float n1 = texture2D(tMist, q + uHwTime * vec2(0.012, 0.007) * vM.y + vM.z).a;
        float n2 = texture2D(tMist, q * 1.7 - uHwTime * vec2(0.009, -0.011) * vM.y + vM.z * 2.3).a;
        float edge = smoothstep(0.5, 0.18, length(vUv - 0.5));
        float vis = smoothstep(vM.w, vM.w + 0.3, uHwAmt) * (0.12 + 0.88 * uHwNight);
        float a = n1 * n2 * 1.9 * edge * vM.x * vis * smoothstep(0.8, 5.0, vDist);
        if (a < 0.003) discard;
        vec3 col = mix(vec3(0.78, 0.82, 0.86), vec3(0.17, 0.2, 0.3), uHwNight);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
}

function buildExtras(ctx, { glow, foot, tmpRail, hooks }) {
  const { group, rand } = ctx;
  const own = ctx.own;
  const clothGrey = greyscaleTexture(ctx.tex['floral_jacquard:d'], { contrast: 1.0, lift: 38 });
  const linenGrey = greyscaleTexture(ctx.tex['rough_linen:d'], { contrast: 1.05, lift: 30 });
  own.push(clothGrey, linenGrey);
  const COLORS = [[0.85 * 3.2, 0.32 * 3.2, 0.03 * 3.2], [0.17 * 3.4, 0.07 * 3.4, 0.28 * 3.4], [0.07 * 4, 0.06 * 4, 0.08 * 4], [0.72 * 2.4, 0.68 * 2.4, 0.56 * 2.4], [0.3 * 3.4, 0.03 * 3.4, 0.07 * 3.4], [0.14 * 3, 0.3 * 3, 0.07 * 3]];
  const pickColor = (i) => COLORS[[0, 2, 1, 0, 3, 2, 4, 0, 1, 2][i % 10]];

  const RAG_COLORS = [[0.5, 0.42, 0.55], [0.3, 0.26, 0.34], [0.62, 0.3, 0.2], [0.36, 0.22, 0.42], [0.55, 0.5, 0.42]];
  // ---- bunting between the lantern crooks -------------------------------------------------------------
  const bunting = new Merger({ uv: true });
  const strings = new Merger();
  const run = (A, B, { sag = 0.45, step = 0.62, start = 0.5, colorOffset = 0 } = {}) => {
    const a = new THREE.Vector3(...A), b = new THREE.Vector3(...B);
    const len = a.distanceTo(b), n = Math.max(3, Math.round(len / step));
    const curve = (t, out) => out.lerpVectors(a, b, t).setY(out.y - sag * 4 * t * (1 - t));
    const pts = []; for (let i = 0; i <= 14; i++) pts.push(curve(i / 14, new THREE.Vector3()));
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.012, 4, false);
    strings.add(tube, { color: [0.07, 0.06, 0.06], pivot: A, start }); tube.dispose();
    const T = new THREE.Vector3().subVectors(b, a).normalize(), P = new THREE.Vector3(), L = new THREE.Vector3(), R = new THREE.Vector3(), Tip = new THREE.Vector3();
    for (let i = 1; i < n; i++) {
      const t = i / n; curve(t, P);
      const w = 0.2 + rand() * 0.06, h = 0.4 + rand() * 0.18;
      L.copy(P).addScaledVector(T, -w); R.copy(P).addScaledVector(T, w);
      Tip.copy(P).add(new THREE.Vector3((rand() - 0.5) * 0.06, -h, (rand() - 0.5) * 0.06)).addScaledVector(T, (rand() - 0.5) * 0.06);
      const g = tri(L.toArray(), R.toArray(), Tip.toArray(), [0, 0], [1, 0], [0.5, 1]);
      bunting.add(g, { color: pickColor(i + colorOffset), pivot: P.toArray(), start: start + (t - 0.5) * 0.1 }); g.dispose();
    }
  };
  const H = hooks;
  run([H[0].hx, H[0].hy, H[0].hz], [H[1].hx, H[1].hy, H[1].hz], { sag: 0.5, start: 0.45 });
  run([H[1].hx, H[1].hy, H[1].hz], [H[2].hx, H[2].hy, H[2].hz], { sag: 0.55, start: 0.5, colorOffset: 3 });
  run([H[3].hx, H[3].hy, H[3].hz], [H[4].hx, H[4].hy, H[4].hz], { sag: 0.5, start: 0.47, colorOffset: 1 });
  run([H[4].hx, H[4].hy, H[4].hz], [H[5].hx, H[5].hy, H[5].hz], { sag: 0.5, start: 0.52, colorOffset: 5 });
  run([H[8].hx, H[8].hy + 0.1, H[8].hz], [H[0].hx, H[0].hy + 0.05, H[0].hz], { sag: 0.7, start: 0.55, colorOffset: 2 });
  run([H[8].hx, H[8].hy + 0.1, H[8].hz], [H[3].hx, H[3].hy + 0.05, H[3].hz], { sag: 0.7, start: 0.56, colorOffset: 4 });
  run([H[6].hx, H[6].hy + 0.15, H[6].hz + 0.1], [H[7].hx, H[7].hy + 0.15, H[7].hz + 0.1], { sag: 0.4, start: 0.5, step: 0.5 });
  const buntingGeometry = bunting.build(), stringGeometry = strings.build();
  const hangMat = clothMaterial(ctx, { map: clothGrey, normalMap: ctx.tex['floral_jacquard:n'], mode: 'hang', tatter: 0.55, key: 'bunting' });
  const stringMat = ironMaterial(ctx);
  const buntingMesh = new THREE.Mesh(buntingGeometry, hangMat); buntingMesh.name = 'Tattered bunting';
  const stringMesh = new THREE.Mesh(stringGeometry, stringMat); stringMesh.name = 'Bunting lines';
  group.add(buntingMesh, stringMesh); own.push(buntingGeometry, stringGeometry, hangMat, stringMat);
  ctx.counts.buntingFlags = buntingGeometry.attributes.position.count / 3;

  // ---- rags and spider-web banners hanging from the booms ---------------------------------------------------
  const rags = new Merger({ uv: true });
  const hangFrom = (y, z, xs, lenRange, start) => {
    for (const x of xs) {
      const len = lenRange[0] + rand() * (lenRange[1] - lenRange[0]), w = 0.28 + rand() * 0.25;
      const g = ragGeometry(w, len, rand); g.translate(x, y, z);
      rags.add(g, { color: RAG_COLORS[Math.floor(rand() * RAG_COLORS.length)], pivot: [x, y, z], start: start + rand() * 0.15 }); g.dispose();
    }
  };
  const xsMain = []; for (let x = -8.6; x <= 9.8; x += 1.45) xsMain.push(x + (rand() - 0.5) * 0.5);
  hangFrom(15.5, -3.34, xsMain, [1.2, 3.2], 0.6);
  const xsAft = []; for (let x = -4.8; x <= 5.8; x += 1.4) xsAft.push(x + (rand() - 0.5) * 0.4);
  hangFrom(13.0, -12.1, xsAft, [1.0, 2.6], 0.62);
  const ragGeometryMerged = rags.build();
  const ragMat = clothMaterial(ctx, { map: linenGrey, normalMap: ctx.tex['rough_linen:n'], mode: 'hang', tatter: 0.85, key: 'rags' });
  const ragMesh = new THREE.Mesh(ragGeometryMerged, ragMat); ragMesh.name = 'Tattered rags'; group.add(ragMesh); own.push(ragGeometryMerged, ragMat);
  ctx.counts.rags = xsMain.length + xsAft.length;

  const velourGrey = greyscaleTexture(ctx.tex['velour_velvet:d'], { contrast: 1.0, lift: 55 });
  const bannerTex = bannerTexture(velourGrey.image); own.push(bannerTex, velourGrey);
  const bannerMerger = new Merger({ uv: true });
  const banner = (x, y, z, w, h, start) => {
    const g = new THREE.PlaneGeometry(w, h, 1, 8); const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const v = 1 - uv.getY(i); uv.setY(i, v * 0.96); pos.setY(i, pos.getY(i) - h / 2 + (v > 0.9 ? (rand() - 0.5) * 0.12 : 0)); }
    g.translate(x, y, z); g.computeVertexNormals();
    bannerMerger.add(g, { color: [1.4, 1.4, 1.4], pivot: [x, y, z], start }); g.dispose();
  };
  for (const x of [-7.4, -2.2, 3.1, 8.3]) banner(x, 15.45, -3.5, 1.3, 3.1, 0.62);
  for (const x of [-3.6, 0.3, 4.2]) banner(x, 12.95, -12.3, 1.1, 2.6, 0.64);
  const bannerGeometry = bannerMerger.build();
  const bannerMat = clothMaterial(ctx, { map: bannerTex, normalMap: ctx.tex['velour_velvet:n'], mode: 'hang', tatter: 0.35, key: 'banner' });
  const bannerMesh = new THREE.Mesh(bannerGeometry, bannerMat); bannerMesh.name = 'Spider web banners'; group.add(bannerMesh); own.push(bannerGeometry, bannerMat);
  ctx.counts.banners = 7;

  // ---- flags -------------------------------------------------------------------------------------------------
  const flagTextures = [jollyRogerTexture('#ff7a12'), jollyRogerTexture('#8f5cff')]; own.push(...flagTextures);
  const flag = (tex, x, y, z, w, h, start) => {
    const g = new THREE.PlaneGeometry(w, h, 14, 8); g.translate(w / 2, 0, 0); g.rotateY(Math.PI / 2); g.translate(x, y, z);
    const m = new Merger({ uv: true }); m.add(g, { color: [1.35, 1.35, 1.35], pivot: [x, y, z], start }); g.dispose();
    const geo = m.build();
    const mat = clothMaterial(ctx, { map: tex, mode: 'flag', tatter: 0.9, key: `flag${flagTextures.indexOf(tex)}` });
    const mesh = new THREE.Mesh(geo, mat); mesh.name = 'Tattered pirate flag'; group.add(mesh); own.push(geo, mat);
  };
  flag(flagTextures[0], 0.0, 47.4, -3.4, 4.6, 3.0, 0.65);
  flag(flagTextures[1], 0.0, 30.9, -12.0, 3.2, 2.1, 0.66);
  ctx.counts.flags = 2;

  // ---- cobwebs ----------------------------------------------------------------------------------------------
  const webTex = webTexture(); own.push(webTex);
  const webs = new Merger({ uv: true });
  const web = (corner, a, b, size, start = 0.6) => {
    const A = new THREE.Vector3(...a).normalize().multiplyScalar(size), B = new THREE.Vector3(...b).normalize().multiplyScalar(size);
    const c = new THREE.Vector3(...corner);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...c.toArray(), ...c.clone().add(A).toArray(), ...c.clone().add(B).toArray(), ...c.clone().add(A).add(B).toArray()], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)); g.setIndex([0, 1, 2, 1, 3, 2]); g.computeVertexNormals();
    webs.add(g, { color: [1, 1, 1], pivot: c.toArray(), start }); g.dispose();
  };
  for (const hk of [H[0], H[1], H[2], H[3], H[4], H[5]]) {
    const sd = hk.hx > 0 ? 1 : -1;
    web([hk.hx + sd * 0.62, hk.hy + 0.12, hk.hz + 0.02], [-sd, 0, 0], [0, -1, 0], 0.85, 0.55);
  }
  web([-0.8, 3.3, -7.52], [-1, 0, 0], [0, 1, 0], 0.95); web([0.8, 3.3, -7.52], [1, 0, 0], [0, 1, 0], 0.95);
  for (const th of [0.3, 0.62, 0.8]) {
    const x = Math.cos(th * Math.PI) * 4.78, z = -12.5 + Math.sin(th * Math.PI) * 4.78;
    web([x, 5.1, z], [-Math.sin(th * Math.PI), 0, Math.cos(th * Math.PI)], [0, -1, 0], 1.25);
  }
  for (const sd of [1, -1]) { railAt(11.3, tmpRail); web([sd * tmpRail.x, tmpRail.top, 11.3], [0, 0, -1], [0, -1, 0], 1.4, 0.6); }
  const webGeometry = webs.build();
  const webMat = patchDeco(new THREE.MeshStandardMaterial({ map: webTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 1, alphaTest: 0.02, vertexColors: true }), ctx, { key: 'web', pivot: true });
  const webMesh = new THREE.Mesh(webGeometry, webMat); webMesh.name = 'Cobwebs'; webMesh.renderOrder = 3; group.add(webMesh); own.push(webGeometry, webMat);
  ctx.counts.cobwebs = 6 + 2 + 3 + 2;

  // ---- ravens on perches ---------------------------------------------------------------------------------------
  const ravenPlacements = [];
  const raven = (x, y, z, ry, s = 1.15) => ravenPlacements.push({ matrix: compose(x, y, z, ry, s).clone(), start: 0.55 + rand() * 0.2 });
  railAt(0.35, tmpRail); raven(tmpRail.x, tmpRail.top + 0.02, 0.35 + 0.0, -0.6);
  railAt(7.4, tmpRail); raven(-tmpRail.x, tmpRail.top + 0.02, 7.4, 1.0);
  railAt(-1.3, tmpRail); raven(-tmpRail.x, tmpRail.top + 0.02, -1.3, 0.9, 1.0);
  raven(0.0, 10.75, -13.2, 0.5, 1.4);                       // dome finial
  raven(-3.48 + 0.1, 6.95 + 0.5, -12.5, 2.4, 1.0);         // top of the balcony tree
  raven(4.22, 2.6 + 0.05, -5.2, -2.0, 1.0);                // top of the deck tree
  raven(8.3, 15.7, -3.3, 1.5, 1.4);                        // main boom end
  const ravenGeo = ravenGeometry();
  const ravenMesh = instanced(ravenGeo, boneInstanceMaterial(ctx), ravenPlacements, 'Ravens'); group.add(ravenMesh); own.push(ravenGeo, ravenMesh.material); ctx.counts.ravens = ravenPlacements.length;

  // ---- black cat on the balcony rail, glowing eyes -----------------------------------------------------------------
  const catGeo = catGeometry(); withAppear(catGeo, [0, 5.14, -7.8], 0.58);
  catGeo.applyMatrix4(compose(0, 5.14, -7.78, 0.0, 1.15).clone());
  const catMesh = new THREE.Mesh(catGeo, boneMaterial(ctx)); catMesh.name = 'Black cat'; group.add(catMesh); own.push(catGeo, catMesh.material); ctx.counts.cats = 1;
  glow(-0.05, 5.14 + 0.52 * 1.15, -7.78 + 0.16 * 1.15, 0.14, 2.4, [0.8, 1, 0.2], 0.6); glow(0.05, 5.14 + 0.52 * 1.15, -7.78 + 0.16 * 1.15, 0.14, 2.4, [0.8, 1, 0.2], 0.6);

  // ---- bats (instanced, wing flap in the vertex shader, orbits on the CPU) -------------------------------------
  const batGeo = batGeometry();
  const batMat = patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x1a1320, roughness: 0.85, side: THREE.DoubleSide }), ctx, {
    key: 'bat',
    vertexPars: 'attribute float aWing; attribute float aPhase;',
    vertexBody: 'float hwFl = sin(uHwTime * (12.0 + aPhase * 5.0) + aPhase * 6.28); transformed.y += hwFl * aWing * 0.2 * hwS; transformed.x *= 1.0 - 0.22 * abs(hwFl) * aWing;',
  });
  const ORBITS = [[0, 11.2, 4.0, 5.2, 8], [-1.5, 12.4, -14.2, 5.0, 7], [0, 9.5, 15.8, 3.6, 4], [0, 42.5, -3.4, 6.5, 6]];
  const bats = [];
  for (const [cx, cy, cz, r, n] of ORBITS) for (let i = 0; i < n; i++) bats.push({ cx, cy, cz, r: r * (0.75 + rand() * 0.5), w: (0.35 + rand() * 0.3) * (rand() < 0.5 ? 1 : -1) * (cy > 30 ? 0.7 : 1), ph: rand() * TAU, bob: 0.5 + rand() * 1.2, bobPh: rand() * TAU, s: 1.1 + rand() * 0.5, start: 0.58 + rand() * 0.2 });
  const batItems = bats.map((b) => ({ matrix: new THREE.Matrix4(), start: b.start }));
  const batMesh = instanced(batGeo, batMat, batItems, 'Bats'); batMesh.frustumCulled = false;
  batGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(Float32Array.from(bats.map(() => rand())), 1));
  group.add(batMesh); own.push(batGeo, batMat); ctx.counts.bats = bats.length;
  ctx.flyers.push((time) => {
    for (let i = 0; i < bats.length; i++) {
      const b = bats[i], th = b.ph + b.w * time;
      const x = b.cx + Math.cos(th) * b.r, z = b.cz + Math.sin(th) * b.r, y = b.cy + Math.sin(th * 2 + b.bobPh) * b.bob;
      // heading = tangent of the orbit
      const yaw = Math.atan2(-Math.sin(th) * Math.sign(b.w), Math.cos(th) * Math.sign(b.w));
      batMesh.setMatrixAt(i, compose(x, y, z, yaw, b.s, 0.12 * Math.cos(th * 2 + b.bobPh), -0.4 * Math.sign(b.w), _fm));
    }
    batMesh.instanceMatrix.needsUpdate = true;
  });

  // ---- ghosts (translucent wisps; always face the camera) ----------------------------------------------------------
  const ghostGeo = ghostGeometry();
  const ghostMat = ghostMaterial(ctx);
  const ghosts = [
    { c: [0, 7.4, -12.5], r: 6.9, w: 0.11, y: 0.6, s: 1.9, start: 0.6 },
    { c: [10.2, 3.0, 2.0], r: 2.6, w: -0.17, y: 0.7, s: 1.5, start: 0.64 },
    { c: [-10.2, 3.4, 1.0], r: 2.8, w: 0.15, y: 0.8, s: 1.7, start: 0.66 },
    { c: [0, 8.2, 17.5], r: 2.4, w: 0.2, y: 0.6, s: 1.4, start: 0.68 },
    { c: [0, 14.0, 4.0], r: 6.2, w: -0.09, y: 1.1, s: 2.2, start: 0.7 },
  ].map((g) => ({ ...g, ph: rand() * TAU }));
  const ghostItems = ghosts.map((g) => ({ matrix: new THREE.Matrix4(), start: g.start }));
  const ghostMesh = instanced(ghostGeo, ghostMat, ghostItems, 'Ghost wisps'); ghostMesh.frustumCulled = false; ghostMesh.renderOrder = 7;
  group.add(ghostMesh); own.push(ghostGeo, ghostMat); ctx.counts.ghosts = ghosts.length;
  const camLocal = new THREE.Vector3();
  ctx.flyers.push((time, camera) => {
    if (camera) { camLocal.copy(camera.position); group.worldToLocal(camLocal); }
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i], th = g.ph + g.w * time;
      const x = g.c[0] + Math.cos(th) * g.r, z = g.c[2] + Math.sin(th) * g.r, y = g.c[1] + Math.sin(time * 0.7 + g.ph * 2) * g.y;
      const yaw = camera ? Math.atan2(camLocal.x - x, camLocal.z - z) : -th;
      ghostMesh.setMatrixAt(i, compose(x, y, z, yaw, g.s, 0.06 * Math.sin(time * 0.9 + g.ph), 0.08 * Math.sin(time * 0.6 + g.ph * 3), _fm));
    }
    ghostMesh.instanceMatrix.needsUpdate = true;
  });

  // ---- mist sheets ----------------------------------------------------------------------------------------------------
  const mistTex = mistTexture(); own.push(mistTex);
  const mistGeo = new THREE.PlaneGeometry(1, 1); mistGeo.rotateX(-Math.PI / 2);
  const MIST = [[0, 0.3, 3, 13, 26, 0.16, 1.0, 0.1], [0, 0.75, -1, 12, 22, 0.1, 0.8, 0.14], [0, 0.45, -11, 12, 9, 0.2, 1.2, 0.2], [0, 0.5, 14, 9, 9, 0.2, 0.9, 0.2],
    [0, -2.7, 0, 34, 66, 0.34, 0.7, 0.05], [0, -1.5, -2, 28, 56, 0.2, 1.1, 0.12]];
  const mistMesh = new THREE.InstancedMesh(mistGeo, mistMaterial(ctx, mistTex), MIST.length);
  const mistAttr = new Float32Array(MIST.length * 4);
  MIST.forEach(([x, y, z, sx, sz, a, sp, st], i) => { mistMesh.setMatrixAt(i, compose(x, y, z, 0, new THREE.Vector3(sx, 1, sz)).clone()); mistAttr.set([a, sp, rand() * 10, st], i * 4); });
  mistGeo.setAttribute('aMist', new THREE.InstancedBufferAttribute(mistAttr, 4));
  mistMesh.frustumCulled = false; mistMesh.renderOrder = 8; mistMesh.name = 'Deck and sea mist';
  group.add(mistMesh); own.push(mistGeo, mistMesh.material); ctx.counts.mistSheets = MIST.length;

  // ---- moon-orange glow behind the dome ---------------------------------------------------------------------------------
  glow(0, 9.2, -12.2, 10, 0.55, [1, 0.42, 0.08], 0.6, 1.0);
  glow(0, 6.6, -12.5, 6.5, 0.4, [1, 0.5, 0.12], 0.6, 2.0);
}

function buildCore(ctx) {
  const { group, rand } = ctx;
  const foot = (name, x, z, r, y0 = 0, y1 = 1) => ctx.footprints.push({ name, x, z, r, y0, y1 });
  const sprites = [];
  const glow = (x, y, z, size, intensity, color, start, phase = rand() * 6.3) => sprites.push({ x, y, z, size, intensity, color, start, phase });
  const ORANGE = [1, 0.5, 0.1], WARM = [1, 0.62, 0.22];

  // ---- pumpkins ---------------------------------------------------------------------------------
  const pumpkins = [];
  const pump = (x, y, z, s, { face = Math.floor(rand() * 4), ry = rand() * TAU, rx = 0, rz = 0, tint, glowK = 1, start = 0.12 + rand() * 0.4, low = false, name = 'pumpkin', sprite = true, fy = 0.39 } = {}) => {
    const color = new THREE.Color(tint ?? pickTint(rand));
    pumpkins.push({ matrix: compose(x, y, z, ry, s, rx, rz).clone(), color, face, phase: rand(), glow: face >= 0 ? glowK : 0, start, low });
    if (face >= 0 && sprite) glow(x, y + s * 0.02, z, s * (low ? 1.5 : 2.3), 0.55 * glowK, ORANGE, start);
    foot(name, x, z, s * 0.5, y - s * fy, y + s * 0.45);
  };
  const tmpRail = { x: 0, top: 0 };
  // rail caps
  const railZ = [-5.4, -2.5, 0.4, 3.3, 6.1, 8.7, 10.7];
  for (const side of [1, -1]) railZ.forEach((z0, i) => {
    const z = z0 + (side > 0 ? 0 : 0.9);
    railAt(z, tmpRail);
    const s = 0.52 + rand() * 0.2;
    pump(side * tmpRail.x, tmpRail.top + s * 0.36, z, s, { ry: side > 0 ? 0.35 + (rand() - 0.5) * 0.5 : Math.PI / 2 - 0.25 + (rand() - 0.5) * 0.5, face: rand() < 0.18 ? -1 : Math.floor(rand() * 4), name: 'rail pumpkin' });
  });
  // promenade clusters (offset along the rail, inboard)
  const cluster = (side, z0, set) => {
    railAt(z0, tmpRail);
    for (const [dz, din, s, f] of set) {
      const z = z0 + dz; railAt(z, tmpRail);
      const x = side * (tmpRail.x - 0.62 - din);
      pump(x, s * 0.37, z, s, { face: f, ry: side > 0 ? -0.9 + rand() * 0.8 : 0.9 - rand() * 0.8 + (side < 0 ? 0.6 : 0), name: 'promenade pumpkin' });
    }
  };
  cluster(1, -1.2, [[0, 0, 0.9, 0], [0.75, 0.25, 0.55, 1], [-0.7, 0.2, 0.45, -1], [0.3, 0.55, 0.38, 3], [-0.2, -0.05, 0.3, -1]]);
  cluster(1, 5.6, [[0, 0, 0.8, 2], [0.7, 0.2, 0.5, -1], [-0.65, 0.25, 0.42, 1], [0.2, 0.55, 0.34, -1]]);
  cluster(-1, 1.2, [[0, 0, 0.85, 1], [0.7, 0.2, 0.5, 3], [-0.7, 0.25, 0.46, -1], [0.1, 0.5, 0.36, 0], [0.45, -0.1, 0.3, -1]]);
  cluster(-1, 11.0, [[0, 0, 0.6, 1], [0.5, 0.15, 0.4, -1]]);
  cluster(-1, 7.4, [[0, 0, 0.75, 0], [0.6, 0.2, 0.45, 3], [-0.6, 0.25, 0.4, -1]]);
  // mast base, aft of the mast (the patrol loop passes at its sides)
  for (const [x, z, s, f, ry] of [[0.0, -4.55, 0.75, 1, 0.1], [-0.72, -4.2, 0.45, -1, 0.5], [0.7, -4.2, 0.42, 2, -0.4], [0.1, -5.1, 0.3, 0, 0.2]]) pump(x, s * 0.37, z, s, { face: f, ry, name: 'mast pumpkin' });
  // flanking the cabin door
  pump(-2.0, 0.31, -7.25, 0.85, { face: 0, ry: 0.15, name: 'door pumpkin' }); pump(2.0, 0.31, -7.25, 0.85, { face: 2, ry: -0.15, name: 'door pumpkin' });
  pump(-3.05, 0.2, -7.2, 0.5, { face: -1, name: 'door pumpkin' }); pump(3.1, 0.2, -7.15, 0.5, { face: 3, ry: -0.3, name: 'door pumpkin' });
  // under the planter trees (soil top = 0.72)
  for (const [cx, cz, base] of [[-4.2, -5.2, 0.72], [4.2, -5.2, 0.72], [-3.5, -12.5, 4.86]]) {
    for (let k = 0; k < 3; k++) {
      const a = 0.8 + k * 2.1 + (cx > 0 ? 0.5 : 0), s = 0.3 + rand() * 0.12;
      pump(cx + Math.cos(a) * 0.42, base + s * 0.36, cz + Math.sin(a) * 0.42, s, { face: k === 1 ? -1 : Math.floor(rand() * 4), name: 'planter pumpkin' });
    }
  }
  // balcony ring (floor 4.2, rail cap 5.1, centre (0,-12.5), r 4.7)
  for (let k = 0; k < 11; k++) {
    const th = Math.PI * (0.04 + 0.92 * (k / 10)); // front arc (+z side) around the balcony centre
    const x = Math.cos(th) * 4.72, z = -12.5 + Math.sin(th) * 4.72;
    const s = k % 3 === 0 ? 0.62 : 0.45;
    if (k === 5) continue; // the black cat sits here
    pump(x, 5.14 + s * 0.35, z, s, { ry: -th + Math.PI / 2 + 0.3, face: k % 4 === 3 ? -1 : (k % 4), name: 'balcony pumpkin' });
  }
  // bow: both bulwarks where the rail rises
  for (const side of [1, -1]) { railAt(11.9, tmpRail); pump(side * (tmpRail.x - 0.1), tmpRail.top + 0.25, 11.9, 0.6, { ry: side * 0.6, name: 'bow pumpkin' }); }
  // fruit -> hanging jack-o'-lanterns
  for (const f of ctx.fruit) {
    pump(f.x, f.y, f.z, f.size * 1.45, { low: true, name: 'hanging pumpkin', start: f.start, glowK: 0.9, sprite: true });
    ctx.footprints.pop();
  }
  addPumpkins(ctx, pumpkins);

  // ---- dead trees ------------------------------------------------------------------------------------
  const treeGeometry = deadTreeGeometry(ctx, ctx.trees, rand);
  const barkMat = patchDeco(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), ctx, { key: 'bark', pivot: true });
  const trees = new THREE.Mesh(treeGeometry, barkMat); trees.name = 'Dead planter trees'; trees.receiveShadow = true;
  group.add(trees); ctx.own.push(treeGeometry, barkMat); ctx.counts.deadTrees = ctx.trees.length;

  // ---- lanterns (Poly Haven wooden_lantern_01), hung from iron crooks -----------------------------
  const ironMerger = new Merger();
  const LS = 1.5, RING = 0.505 * LS;
  const lanterns = []; // { hook:[x,y,z], phase, amp }
  const hang = (hx, hy, hz, { bracketFrom, amp = 0.09, start = 0.05 + rand() * 0.15, scale = LS } = {}) => {
    lanterns.push({ hx, hy, hz, phase: rand() * TAU, amp, start, scale });
    const ly = hy - 0.18 - 0.505 * scale;
    glow(hx, ly + 0.17 * scale, hz, 2.4 * scale, 0.95, WARM, start);
    foot('lantern', hx, hz, 0.28 * scale, ly, hy);
    // chain
    const chain = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 4, 1);
    ironMerger.add(chain, { matrix: compose(hx, hy - 0.1, hz).clone(), color: [0.1, 0.09, 0.09], pivot: [hx, hy, hz], start });
    chain.dispose();
    if (bracketFrom) {
      const pts = bracketFrom.map((p) => new THREE.Vector3(...p));
      const curve = new THREE.CatmullRomCurve3(pts);
      const g = new THREE.TubeGeometry(curve, 16, 0.028, 5, false);
      ironMerger.add(g, { color: [0.07, 0.06, 0.065], pivot: bracketFrom[0], start }); g.dispose();
      const base = new THREE.CylinderGeometry(0.1, 0.12, 0.08, 8, 1);
      ironMerger.add(base, { matrix: compose(bracketFrom[0][0], bracketFrom[0][1] + 0.04, bracketFrom[0][2]).clone(), color: [0.07, 0.06, 0.065], pivot: bracketFrom[0], start }); base.dispose();
    }
  };
  const post = (side, z0, extra = {}) => {
    railAt(z0, tmpRail);
    const bx = side * (tmpRail.x - 0.3), top = tmpRail.top + 1.3;
    const hx = bx - side * 0.62, hy = top - 0.05;
    hang(hx, hy, z0, { bracketFrom: [[bx, 0, z0], [bx, top * 0.6, z0], [bx, top - 0.05, z0], [bx - side * 0.2, top + 0.14, z0], [hx + side * 0.1, top + 0.1, z0], [hx, hy + 0.01, z0]], ...extra });
    foot('lantern post', bx, z0, 0.12, 0, top);
  };
  post(1, -3.9); post(1, 3.5); post(1, 9.3); post(-1, -1.2); post(-1, 5.6); post(-1, 10.3);
  // cabin door: wall brackets
  for (const sx of [-1, 1]) hang(sx * 1.65, 3.2, -7.2, { bracketFrom: [[sx * 1.65, 3.25, -7.62], [sx * 1.65, 3.45, -7.45], [sx * 1.65, 3.45, -7.28], [sx * 1.65, 3.25, -7.2]] });
  // main mast: arm out to port side, above the loop
  hang(0.0, 3.5, -2.55, { bracketFrom: [[0, 3.75, -3.1], [0, 3.95, -2.95], [0, 3.95, -2.7], [0, 3.52, -2.55]] });
  // stern balcony corners
  const lanternParts = ctx.models.wooden_lantern_01;
  const lanternMatrices = lanterns.map((l) => compose(l.hx, l.hy - 0.18 - 0.505 * l.scale, l.hz, 0, l.scale).clone());
  const lanternMeshes = lanternSet(ctx, lanternParts, lanternMatrices, lanterns.map((l) => l.start), 'lantern', 0xff8a1f);
  ctx.swing.push({ meshes: lanternMeshes, list: lanterns, rand });
  const ironGeometry = ironMerger.build();
  const iron = new THREE.Mesh(ironGeometry, ironMaterial(ctx)); iron.name = 'Lantern crooks and chains'; group.add(iron); ctx.own.push(ironGeometry, iron.material);
  ctx.counts.lanterns = lanterns.length;

  buildProps(ctx, { glow, foot, tmpRail });
  buildExtras(ctx, { glow, foot, tmpRail, hooks: lanterns });

  // ---- glow sprites + point lights ----------------------------------------------------------------------
  const spriteMesh = glowSprites(ctx, sprites, 'Halloween glow sprites');
  group.add(spriteMesh); ctx.own.push(spriteMesh.geometry); ctx.counts.glowSprites = sprites.length;
  const LIGHTS = [
    { pos: [0, 3.2, -2.9], color: 0xff9440, base: 36, dist: 20 },
    { pos: [0, 4.6, -9.6], color: 0xffa14a, base: 34, dist: 14 },
    { pos: lanterns[1] ? [lanterns[1].hx, lanterns[1].hy - 0.5, lanterns[1].hz] : [6, 2, 3], color: 0xff8a2a, base: 26, dist: 14 },
    { pos: lanterns[3] ? [lanterns[3].hx, lanterns[3].hy - 0.5, lanterns[3].hz] : [-6, 2, -1], color: 0xff8a2a, base: 26, dist: 14 },
    { pos: [-3.0, 1.2, 9.6], color: 0x55ff66, base: 14, dist: 9 },
    { pos: [0, 6.2, -11.0], color: 0xff6a1a, base: 40, dist: 16 },
  ].slice(0, ctx.maxLights);
  for (const L of LIGHTS) {
    const light = new THREE.PointLight(L.color, 0, L.dist, 2);
    light.position.set(...L.pos); light.castShadow = false; light.visible = false; light.userData = { base: L.base, phase: rand() * TAU };
    group.add(light); ctx.lights.push(light);
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
// planter trunks in ship coordinates: x, z, y of the trunk top
const TREE_SPOTS = [{ x: -4.18, z: -5.2, top: 2.6 }, { x: 4.22, z: -5.2, top: 2.6 }, { x: -3.48, z: -12.5, top: 6.8 }];

export async function createHalloweenTheme({ scene, deck, ship, patrol, loader, textureLoader, renderer, anisotropy = 4, assetBase = '', maxLights = 4 }) {
  const U = { amt: { value: 0 }, time: { value: 0 }, night: { value: 0 }, flash: { value: 0 } };
  const tex = {};
  const jobs = [];
  const loadTexture = (url, srgb, key) => jobs.push(textureLoader.loadAsync(url).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    tex[key] = t;
  }));
  const wantTex = new Map();
  for (const spec of Object.values(SPECS)) if (spec.map) wantTex.set(spec.map, spec);
  for (const [id, spec] of wantTex) {
    loadTexture(`${assetBase}${TEXTURE_DIR}${id}/${id}_diff_1k.jpg`, true, `${id}:d`);
    if (spec.nor) loadTexture(`${assetBase}${TEXTURE_DIR}${id}/${id}_nor_gl_1k.jpg`, false, `${id}:n`);
    if (spec.rgh) loadTexture(`${assetBase}${TEXTURE_DIR}${id}/${id}_rough_1k.jpg`, false, `${id}:r`);
  }
  for (const id of CLOTH_TEXTURE_IDS) {
    loadTexture(`${assetBase}${TEXTURE_DIR}${id}/${id}_diff_1k.jpg`, true, `${id}:d`);
    loadTexture(`${assetBase}${TEXTURE_DIR}${id}/${id}_nor_gl_1k.jpg`, false, `${id}:n`);
  }
  const models = {};
  for (const id of MODEL_IDS) jobs.push(loadModelParts(loader, assetBase, id).then((parts) => { models[id] = parts; }));
  await Promise.all(jobs);

  const group = new THREE.Group();
  group.name = 'Halloween decorations';
  group.visible = false;
  const ctx = { U, tex, group, models, rand: mulberry(31337), own: [], footprints: [], lights: [], glass: [], swing: [], flyers: [], counts: {}, fruit: [], trees: [], faceTex: null, spriteMaterial: null, maxLights: Math.max(0, Math.min(6, maxLights | 0)) };
  ctx.faceTex = faceAtlas(); ctx.spriteMaterial = createSpriteMaterial(ctx);
  ctx.own.push(ctx.faceTex, ctx.spriteMaterial);

  // ---- ship overrides -----------------------------------------------------------------------
  const originals = new Map(); // mesh -> { material, geometry }
  const themedMaterials = new Map();
  const overrides = [];
  ship.traverse((mesh) => {
    if (!mesh.isMesh) return;
    for (const [pattern, specId] of SHIP_RULES) {
      if (!pattern.test(mesh.name)) continue;
      const base = mesh.material;
      const cacheKey = `${specId}|${base.uuid}`;
      let themed = themedMaterials.get(cacheKey);
      if (!themed) { themed = buildShipMaterial(base, specId, ctx); themedMaterials.set(cacheKey, themed); }
      let geometry = null;
      if (SPECS[specId].shrink) {
        const shrunk = withShrinkAttributes(mesh.geometry, mesh.id);
        geometry = shrunk.geometry;
        if (specId === 'fruitShrink') {
          for (const c of shrunk.components) {
            const size = Math.max(c.max.x - c.min.x, c.max.z - c.min.z);
            ctx.fruit.push({ x: c.centre.x, y: c.centre.y, z: c.centre.z, size, start: c.start });
          }
        }
      }
      overrides.push({ mesh, themed, geometry, specId });
      originals.set(mesh, { material: base, geometry: mesh.geometry });
      break;
    }
  });
  for (const tree of TREE_SPOTS) ctx.trees.push({ ...tree, fruit: [] });
  for (const f of ctx.fruit) {
    let best = ctx.trees[0], bd = 1e9;
    for (const t of ctx.trees) { const d = Math.hypot(t.x - f.x, t.z - f.z); if (d < bd) { bd = d; best = t; } }
    best.fruit.push(f);
  }
  let swapped = false;
  const applyOverrides = () => {
    if (swapped) return;
    for (const o of overrides) {
      o.mesh.material = o.themed; if (o.geometry) o.mesh.geometry = o.geometry;
      if (o.themed.userData.hwDepth) o.mesh.customDepthMaterial = o.themed.userData.hwDepth;
    }
    swapped = true;
  };
  const restoreOverrides = () => {
    if (!swapped) return;
    for (const o of overrides) {
      const orig = originals.get(o.mesh); o.mesh.material = orig.material; o.mesh.geometry = orig.geometry;
      if (o.themed.userData.hwDepth) o.mesh.customDepthMaterial = undefined;
    }
    swapped = false;
  };

  // ---- decorations ----------------------------------------------------------------------------
  buildCore(ctx);
  deck.add(group);
  if (renderer?.initTexture) { for (const t of Object.values(tex)) renderer.initTexture(t); renderer.initTexture(ctx.faceTex); }

  // ---- route clearance (static footprints vs the real patrol loop and the skill stage) ----------
  const clearance = measureClearance(ctx.footprints, patrol);

  let amount = 0;
  let destroyed = false;
  let lightsOn = false;
  const swingState = { rx: 0, rz: 0 };
  const _hook = new THREE.Matrix4();
  const updateSwing = (time) => {
    for (let k = 0; k < ctx.swing.length; k++) {
      const s = ctx.swing[k];
      for (let i = 0; i < s.list.length; i++) {
        const l = s.list[i];
        swingState.rz = l.amp * Math.sin(time * 1.25 + l.phase) + 0.035 * Math.sin(time * 2.9 + l.phase * 2.0);
        swingState.rx = l.amp * 0.7 * Math.sin(time * 1.05 + l.phase * 1.7);
        _m.compose(_p.set(l.hx, l.hy, l.hz), _q.setFromEuler(_e.set(swingState.rx, 0, swingState.rz)), _s.set(1, 1, 1));
        _hook.compose(_o.set(0, -(0.18 + 0.505 * l.scale), 0), _q.identity(), _s.set(l.scale, l.scale, l.scale));
        _m.multiply(_hook);
        for (let j = 0; j < s.meshes.length; j++) s.meshes[j].setMatrixAt(i, _m);
      }
      for (let j = 0; j < s.meshes.length; j++) s.meshes[j].instanceMatrix.needsUpdate = true;
    }
  };
  const api = {
    group,
    setAmount(value) {
      if (destroyed) return;
      const a = clamp01(Number.isFinite(value) ? value : 0);
      if (a === amount) return;
      amount = a;
      U.amt.value = a;
      if (a <= 0) {
        restoreOverrides(); group.visible = false;
        if (lightsOn) { for (const l of ctx.lights) { l.visible = false; l.intensity = 0; } lightsOn = false; }
      } else {
        applyOverrides(); group.visible = true;
        if (!lightsOn) { for (const l of ctx.lights) l.visible = true; lightsOn = true; }
      }
    },
    update(time, dt, { night = 0, flash = 0, camera = null } = {}) {
      if (destroyed || amount <= 0) return;
      U.time.value = time; U.night.value = night; U.flash.value = flash;
      const ramp = smooth(0.05, 0.55, amount) * (0.3 + 0.7 * night);
      for (let i = 0; i < ctx.lights.length; i++) {
        const l = ctx.lights[i], ph = l.userData.phase;
        const flick = 1 + 0.16 * Math.sin(time * 11 + ph) + 0.09 * Math.sin(time * 27 + ph * 3) + 0.06 * Math.sin(time * 4.1 + ph * 5);
        l.intensity = l.userData.base * ramp * flick * (1 + flash * 0.4);
      }
      const glassK = amount * (0.35 + 2.4 * night);
      for (let i = 0; i < ctx.glass.length; i++) ctx.glass[i].emissiveIntensity = glassK * (1 + 0.1 * Math.sin(time * 9.3));
      updateSwing(time);
      for (let i = 0; i < ctx.flyers.length; i++) ctx.flyers[i](time, camera);
    },
    /**
     * Build every GPU resource the themed scene needs (shader programs, pipeline states, texture uploads)
     * and then return to the current amount, so the first real `setAmount(>0)` does not stall. It compiles the
     * scene synchronously and draws it once into a single scissored pixel of the canvas. Call again
     * (ideally with the live camera) after changing the scene's lights, fog or shadow settings.
     */
    warm(camera = null) {
      if (destroyed || !renderer?.compile) return;
      const previous = amount;
      const cam = camera ?? new THREE.PerspectiveCamera(50, 1.4, 0.1, 3000);
      if (!camera) { cam.position.set(8, 7, 15); cam.lookAt(0, 1, 1); cam.updateMatrixWorld(true); }
      api.setAmount(1);
      const scissorTest = renderer.getScissorTest(), scissor = renderer.getScissor(new THREE.Vector4());
      try {
        renderer.compile(scene, cam);
        renderer.setScissorTest(true); renderer.setScissor(0, 0, 1, 1);
        renderer.render(scene, cam);
      } finally {
        renderer.setScissor(scissor.x, scissor.y, scissor.z, scissor.w); renderer.setScissorTest(scissorTest);
        api.setAmount(previous);
      }
    },
    snapshot() {
      let triangles = 0, meshes = 0;
      group.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        const g = o.geometry; const tri = (g.index ? g.index.count : g.attributes.position.count) / 3;
        triangles += tri * (o.isInstancedMesh ? o.count : 1);
      });
      return {
        amount,
        decorations: { ...ctx.counts },
        lights: ctx.lights.length,
        lightsActive: lightsOn,
        materials: { shipOverrides: overrides.length, shipSpecs: themedMaterials.size, swapped },
        drawCalls: group.visible ? meshes : 0,
        triangles: group.visible ? Math.round(triangles) : 0,
        clearance,
      };
    },
    destroy() {
      if (destroyed) return;
      restoreOverrides();
      destroyed = true;
      group.removeFromParent();
      for (const l of ctx.lights) l.dispose?.();
      for (const m of themedMaterials.values()) { m.userData.hwDepth?.dispose(); m.dispose(); }
      for (const o of overrides) o.geometry?.dispose();
      for (const o of ctx.own) o.dispose?.();
      group.traverse((o) => { if (o.isMesh) { o.geometry?.dispose(); if (o.dispose) o.dispose(); } });
      // textures that arrived with the Poly Haven models are owned by the theme as well
      const loose = new Set();
      const collect = (m) => { for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) if (m?.[k]) loose.add(m[k]); };
      group.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(collect); });
      for (const o of ctx.own) if (o.isMaterial) collect(o);
      for (const t of loose) t.dispose();
      group.clear();
      for (const t of Object.values(tex)) t.dispose();
    },
  };
  api.warm();
  return api;
}

// Horizontal distance (edge to edge) from every static decoration footprint to the real patrol loop and to the
// 1.5 m skill-stage disc. Decorations whose lowest point is above 2.4 m (hanging lanterns, bunting, rigging)
// cannot touch a 2 m walker, so they are reported separately.
function measureClearance(footprints, patrol) {
  if (!patrol?.sample) return null;
  const out = {};
  const duration = patrol.snapshot?.().duration ?? 46;
  const best = new Float64Array(footprints.length).fill(Infinity);
  for (let t = 0; t < duration; t += 0.05) {
    patrol.sample(t, out);
    for (let i = 0; i < footprints.length; i++) {
      const f = footprints[i];
      const d = Math.hypot(f.x - out.x, f.z - out.z) - f.r;
      if (d < best[i]) best[i] = d;
    }
  }
  let minLow = Infinity, worstLow = null, minHigh = Infinity, worstHigh = null, minStage = Infinity, worstStage = null;
  const tight = [];
  footprints.forEach((f, i) => {
    const stage = Math.hypot(f.x, f.z) - f.r - 1.5;
    if (f.y0 < 2.1) {
      if (best[i] < minLow) { minLow = best[i]; worstLow = f.name; }
      if (stage < minStage) { minStage = stage; worstStage = f.name; }
      tight.push({ name: f.name, x: +f.x.toFixed(2), z: +f.z.toFixed(2), route: +best[i].toFixed(2), stage: +stage.toFixed(2) });
    } else if (best[i] < minHigh) { minHigh = best[i]; worstHigh = f.name; }
  });
  tight.sort((a, b) => a.route - b.route);
  return {
    footprints: footprints.length, lowFootprints: tight.length,
    minRouteLow: +minLow.toFixed(3), worstLow, minStageLow: +minStage.toFixed(3), worstStage,
    minRouteOverhead: Number.isFinite(minHigh) ? +minHigh.toFixed(3) : null, worstOverhead: worstHigh,
    tightest: tight.slice(0, 6),
  };
}
