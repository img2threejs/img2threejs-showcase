import { PALETTE_VERSION, PALETTE_GROUPS, PALETTE_PRESETS } from './interior-palette-data.js';

// Room colour palette engine.
//
// Recolouring is a shader term, not a material swap: every material that a palette group claims gets one extra patch
// (composed with the existing onBeforeCompile / customProgramCacheKey) that multiplies the *albedo* by a per-group linear gain
// (chosen / authored mean). A texture keeps its grain, weave and knit because each texel is scaled, never replaced; a flat
// factor colour becomes exactly the chosen colour. The gain, the "on" flag and the roughness scale are uniforms shared by every
// material of the group, so changing a colour is a uniform write: no program is recompiled, and nothing runs per frame.
// Light is not recoloured: the baked lightmaps hold irradiance only, so indirect colour bleeding stays the authored bake.

const STORAGE_KEY = 'bedroom.palette.v1';
const HASH_KEY = 'palette';
const MAX_PAYLOAD_CHARS = 64 * 1024;
const HISTORY_LIMIT = 100;
const COALESCE_MS = 700;
const PERSIST_DEBOUNCE_MS = 250;
const HEX = /^#?([\da-f]{6})$/i;
const LUMA = [0.2126, 0.7152, 0.0722];
// Default gain denominators never drop below this linear value, so a near-black authored default cannot produce an infinite gain.
const MIN_LINEAR = 0.002;

// ---------------------------------------------------------------------------------------------------------------------
// Colour helpers (pure; unit-tested)

export function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value) {
  if (value >= 1) return 1;
  const v = Math.max(0, value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function hexToLinear(hex) {
  const match = HEX.exec(hex);
  if (!match) throw new Error(`"${hex}" is not a #rrggbb colour.`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel => srgbToLinear(channel / 255));
}

export function linearToHex(rgb) {
  return `#${rgb.map(channel => Math.round(linearToSrgb(channel) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function normalizeHex(hex) {
  const match = typeof hex === 'string' ? HEX.exec(hex.trim()) : null;
  return match ? `#${match[1].toLowerCase()}` : null;
}

const luma = rgb => LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];

// Blackbody colour (Tanner Helland's fit, valid 1000-40000 K), channels in 0..1. Near 2700 K it is ~(1, 0.65, 0.34): the
// authored warm pendant colour, which the viewer feeds to the renderer as a working-space (linear) colour.
export function kelvinToRGB(kelvin) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map(channel => Math.min(255, Math.max(0, channel)) / 255);
}

// Retints an authored light colour from `from` K to `to` K at constant luminance, so a cooler lamp changes hue, not brightness.
// `to === from` returns the authored colour exactly.
export function shiftKelvin(authored, from, to) {
  if (to === from) return authored.slice();
  const a = kelvinToRGB(from);
  const b = kelvinToRGB(to);
  const shifted = authored.map((channel, i) => channel * (Math.max(b[i], 0.02) / Math.max(a[i], 0.02)));
  const scale = luma(authored) / Math.max(luma(shifted), 1e-6);
  return shifted.map(channel => channel * scale);
}

// ---------------------------------------------------------------------------------------------------------------------
// State serialisation (pure; unit-tested)

export function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[\w-]*$/.test(text)) throw new Error('The palette link is not valid base64url.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

export function encodeState(payload) {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeState(text) {
  return JSON.parse(fromBase64Url(text));
}

function hashPayload(hash) {
  if (typeof hash !== 'string' || hash.length < 2) return null;
  return new URLSearchParams(hash.replace(/^#/, '')).get(HASH_KEY);
}

// Small deterministic PRNG for randomize(seed).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexHsl(hex) {
  const [r, g, b] = hexToLinear(hex).map(linearToSrgb);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

// Mesh-name globs: '*' one dotted segment, '**' any run of characters, '?' one character (same rules as createMeshMatcher).
export function createGlobMatcher(patterns) {
  const tests = (patterns ?? []).map(pattern => {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') { if (pattern[i + 1] === '*') { out += '.*'; i++; } else out += '[^.]*'; }
      else if (ch === '?') out += '[^.]';
      else out += ch.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  });
  return key => tests.some(test => test.test(key));
}

const baseMatches = (name, base) => name === base || name.startsWith(`${base}__`);

// ---------------------------------------------------------------------------------------------------------------------
// Shader patch

const PALETTE_UNIFORM_DECL = /* glsl */`
uniform vec3 uPalGain;
uniform vec3 uPalTarget;
uniform float uPalOn;
uniform float uPalRough;
// Albedo above the authored mean rolls off toward 1 instead of clipping, so a bright target keeps its texture detail.
vec3 paletteRecolor( const in vec3 albedo ) {
	vec3 c = albedo * uPalGain;
	vec3 head = max( vec3( 1.0 ) - uPalTarget, vec3( 1e-3 ) );
	vec3 over = max( c - uPalTarget, vec3( 0.0 ) );
	return min( c, uPalTarget ) + head * ( vec3( 1.0 ) - exp( - over / head ) );
}`;

function patchMaterial(material, uniforms) {
  const previous = material.onBeforeCompile;
  const previousKey = Object.hasOwn(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  const previousSource = previous.toString();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    for (const include of ['#include <common>', '#include <color_fragment>', '#include <roughnessmap_fragment>']) {
      if (!shader.fragmentShader.includes(include)) throw new Error(`PBR shader is missing ${include} for the palette recolour.`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PALETTE_UNIFORM_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n\tif ( uPalOn > 0.5 ) diffuseColor.rgb = paletteRecolor( diffuseColor.rgb );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n\tif ( uPalRough != 1.0 ) roughnessFactor = clamp( roughnessFactor * uPalRough, 0.0, 1.0 );`);
    Object.assign(shader.uniforms, uniforms);
  };
  // A program is keyed by the patch that built it; the palette term is part of every claimed material's program from the start.
  material.customProgramCacheKey = () => `${previousKey ? previousKey.call(material) : previousSource}|palette-gain-v1`;
  material.needsUpdate = true;
}

// A claimed material shared with another group (or with unclaimed meshes) is cloned per group; the clone keeps what
// Material.clone() drops (defines reset by MeshStandardMaterial.copy, the shader patch and its program key).
function cloneMaterial(material) {
  const copy = material.clone();
  copy.defines = { ...material.defines };
  copy.onBeforeCompile = material.onBeforeCompile;
  copy.customProgramCacheKey = material.customProgramCacheKey;
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------------

export function createPalette({ session, entries, renderer = null, requestRender = () => {}, storage = safeStorage(),
    location = globalThis.location, data = { PALETTE_VERSION, PALETTE_GROUPS, PALETTE_PRESETS }, now = () => Date.now() } = {}) {
  const groups = data.PALETTE_GROUPS;
  const presets = data.PALETTE_PRESETS;
  const version = data.PALETTE_VERSION;
  const byId = new Map(groups.map(group => [group.id, group]));
  if (byId.size !== groups.length) throw new Error('Palette groups need unique ids.');
  const recolor = groups.filter(group => group.kind === 'recolor');
  const lightGroup = groups.find(group => group.kind === 'light') ?? null;
  const presetById = new Map(presets.map(preset => [preset.id, preset]));

  // ---- authored defaults
  const defaults = { colors: {}, finishes: {}, kelvin: lightGroup?.kelvin?.default ?? 2700 };
  for (const group of groups) {
    const hex = normalizeHex(group.default);
    if (!hex) throw new Error(`Palette group ${group.id} has an invalid default colour.`);
    defaults.colors[group.id] = hex;
    if (group.finish) defaults.finishes[group.id] = group.finish.default;
  }

  // ---- state
  let current = clone(defaults);
  let hint = null;                       // preset id the user last applied; kept only while the state still equals it
  let comparing = false;
  let past = [];
  let future = [];
  let lastEdit = null;                   // { key, at } for coalescing slider drags into one undo step
  let hashConsumed = false;
  let disposed = false;
  const subscribers = new Set();
  let persistTimer = null;

  function clone(snapshot) {
    return { colors: { ...snapshot.colors }, finishes: { ...snapshot.finishes }, kelvin: snapshot.kelvin };
  }
  const snapshot = () => ({ ...clone(current), hint });
  function restore(snap) { current = clone(snap); hint = snap.hint ?? null; }

  function resolvePreset(preset) {
    const resolved = clone(defaults);
    for (const [id, hex] of Object.entries(preset.colors ?? {})) {
      const group = byId.get(id);
      const normal = normalizeHex(hex);
      if (group?.kind === 'recolor' && normal) resolved.colors[id] = normal;
    }
    for (const [id, value] of Object.entries(preset.finishes ?? {})) {
      const group = byId.get(id);
      if (group?.finish && Number.isFinite(value)) resolved.finishes[id] = clamp(value, group.finish.min, group.finish.max);
    }
    if (lightGroup?.kelvin && Number.isFinite(preset.kelvin)) resolved.kelvin = clamp(preset.kelvin, lightGroup.kelvin.min, lightGroup.kelvin.max);
    return resolved;
  }
  const resolvedPresets = presets.map(preset => ({ preset, resolved: resolvePreset(preset) }));

  const equalState = (a, b) => Object.keys(defaults.colors).every(id => recolorOrLight(id) ? a.colors[id] === b.colors[id] : true)
    && Object.keys(defaults.finishes).every(id => Math.abs(a.finishes[id] - b.finishes[id]) < 1e-4)
    && Math.abs(a.kelvin - b.kelvin) < 0.5;
  function recolorOrLight(id) { return byId.get(id).kind === 'recolor'; }
  const isDefault = candidate => equalState(candidate, defaults);

  function activePreset() {
    if (hint) {
      const hinted = resolvedPresets.find(({ preset }) => preset.id === hint);
      if (hinted && equalState(current, hinted.resolved)) return hint;
    }
    return resolvedPresets.find(({ resolved }) => equalState(current, resolved))?.preset.id ?? null;
  }

  // ---- light
  const pendants = (session?.pendants ?? []).map(({ spec, light, bulbs }) => ({
    light, authoredLight: [light.color.r, light.color.g, light.color.b],
    bulbs: bulbs.map(({ material }) => ({ material,
      color: [material.color.r, material.color.g, material.color.b],
      emissive: [material.emissive.r, material.emissive.g, material.emissive.b] })),
    spec,
  }));
  const authoredLightLinear = pendants[0]?.authoredLight ?? (lightGroup ? hexToLinear(defaults.colors[lightGroup.id]) : [1, 1, 1]);
  const lightHex = kelvin => kelvin === defaults.kelvin ? defaults.colors[lightGroup.id] : linearToHex(shiftKelvin(authoredLightLinear, defaults.kelvin, kelvin));

  function applyLight(kelvin) {
    for (const pendant of pendants) {
      pendant.light.color.setRGB(...shiftKelvin(pendant.authoredLight, defaults.kelvin, kelvin));
      for (const bulb of pendant.bulbs) {
        bulb.material.color.setRGB(...shiftKelvin(bulb.color, defaults.kelvin, kelvin));
        bulb.material.emissive.setRGB(...shiftKelvin(bulb.emissive, defaults.kelvin, kelvin));
      }
    }
  }

  // ---- recolour binding
  const groupUniforms = new Map(recolor.map(group => [group.id, {
    uPalGain: { value: [1, 1, 1] }, uPalTarget: { value: [1, 1, 1] }, uPalOn: { value: 0 }, uPalRough: { value: 1 },
  }]));
  const defaultLinear = new Map(recolor.map(group => [group.id, hexToLinear(defaults.colors[group.id])]));
  const matchers = new Map(recolor.filter(group => group.meshes?.length).map(group => [group.id, createGlobMatcher(group.meshes)]));
  const boundMaterials = new Map(recolor.map(group => [group.id, new Set()]));

  function claim(mesh, material) {
    const key = mesh.userData?.physical_id ?? mesh.name;
    let fallback = null;
    for (const group of recolor) {
      if (group.materials?.length ? !group.materials.some(base => baseMatches(material.name, base)) : !matchers.has(group.id)) continue;
      if (matchers.has(group.id)) { if (matchers.get(group.id)(key)) return group; }
      else fallback ??= group;
    }
    return fallback;
  }

  function bindGroups() {
    // material -> Map(groupId | null -> [{ entry, index }])
    const usage = new Map();
    for (const entry of entries ?? []) {
      const list = Array.isArray(entry.pbr) ? entry.pbr : [entry.pbr];
      list.forEach((material, index) => {
        const group = claim(entry.mesh, material);
        const users = usage.get(material) ?? new Map();
        const key = group?.id ?? null;
        users.set(key, [...(users.get(key) ?? []), { entry, index }]);
        usage.set(material, users);
      });
    }
    for (const [material, users] of usage) {
      const claimed = [...users.keys()].filter(Boolean);
      if (!claimed.length) continue;
      const inPlace = !users.has(null);
      const targets = claimed.map((id, order) => ({ id, target: inPlace && order === 0 ? material : cloneMaterial(material) }));
      for (const { id, target } of targets) {
        patchMaterial(target, groupUniforms.get(id));
        boundMaterials.get(id).add(target);
        if (target === material) continue;
        session?.materials?.add(target);
        for (const { entry, index } of users.get(id)) {
          const wasActive = Array.isArray(entry.mesh.material) ? entry.mesh.material[index] === material : entry.mesh.material === material;
          if (Array.isArray(entry.pbr)) entry.pbr = entry.pbr.map((item, i) => i === index ? target : item);
          else entry.pbr = target;
          if (wasActive) {
            if (Array.isArray(entry.mesh.material)) entry.mesh.material = entry.mesh.material.map((item, i) => i === index ? target : item);
            else entry.mesh.material = target;
          }
        }
      }
    }
  }
  bindGroups();
  // A claimed material the group never found is a data bug worth surfacing, not a silent no-op.
  const unmatched = recolor.filter(group => !boundMaterials.get(group.id).size && (entries?.length ?? 0) > 0).map(group => group.id);

  function applyUniforms() {
    const shown = comparing ? defaults : current;
    for (const group of recolor) {
      const uniforms = groupUniforms.get(group.id);
      const target = hexToLinear(shown.colors[group.id]);
      const base = defaultLinear.get(group.id);
      const changed = shown.colors[group.id] !== defaults.colors[group.id];
      uniforms.uPalOn.value = changed ? 1 : 0;
      uniforms.uPalGain.value = target.map((channel, i) => channel / Math.max(base[i], MIN_LINEAR));
      uniforms.uPalTarget.value = target;
      uniforms.uPalRough.value = group.finish ? shown.finishes[group.id] / Math.max(group.finish.default, 1e-3) : 1;
      if (group.finish && Math.abs(shown.finishes[group.id] - group.finish.default) < 1e-4) uniforms.uPalRough.value = 1;
    }
    if (pendants.length && lightGroup) applyLight(shown.kelvin);
    requestRender();
  }

  // ---- public state
  function state() {
    const colors = { ...current.colors };
    if (lightGroup) colors[lightGroup.id] = lightHex(current.kelvin);
    return { version, preset: activePreset(), colors, finishes: { ...current.finishes }, kelvin: current.kelvin,
      modified: !isDefault(current), comparing };
  }

  function notify() {
    const snapshotNow = state();
    for (const subscriber of [...subscribers]) {
      try { subscriber(snapshotNow); } catch (error) { console.error('palette subscriber failed', error); }
    }
  }

  function exportObject() {
    const { version: v, preset, colors, finishes, kelvin } = state();
    const plain = { ...colors };
    if (lightGroup) delete plain[lightGroup.id];
    return { version: v, preset, colors: plain, finishes, kelvin };
  }

  function schedulePersist() {
    if (!storage) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  }

  function flush() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!storage || disposed) return;
    try {
      if (isDefault(current)) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, JSON.stringify(exportObject()));
    } catch { /* storage full or blocked: the palette still works for this visit */ }
  }

  // A loaded #palette= link must stop winning on reload once the user changes something else.
  function dropHash() {
    if (!hashConsumed) return;
    hashConsumed = false;
    try {
      if (location === globalThis.location && globalThis.history?.replaceState) {
        const url = new URL(location.href);
        const params = new URLSearchParams(url.hash.replace(/^#/, ''));
        params.delete(HASH_KEY);
        url.hash = params.toString();
        globalThis.history.replaceState(globalThis.history.state, '', url);
      }
    } catch { /* cosmetic */ }
  }

  // Applies a mutation as one undo step (coalesced when it repeats the same key within COALESCE_MS).
  function commit(key, mutate, { coalesce = false } = {}) {
    if (disposed) return false;
    const before = snapshot();
    const wasComparing = comparing;
    mutate();
    const changed = !equalState(before, current) || wasComparing || before.hint !== hint;
    if (!changed) return false;
    comparing = false;
    const at = now();
    const merge = coalesce && lastEdit?.key === key && at - lastEdit.at < COALESCE_MS && past.length > 0;
    if (!merge) {
      past.push(before);
      if (past.length > HISTORY_LIMIT) past.shift();
    }
    lastEdit = coalesce ? { key, at } : null;
    future = [];
    dropHash();
    applyUniforms();
    schedulePersist();
    notify();
    return true;
  }

  function group(id) {
    const found = byId.get(id);
    if (!found) throw new Error(`Unknown palette group "${id}".`);
    return found;
  }

  function setColor(id, hex) {
    const target = group(id);
    if (target.kind !== 'recolor') throw new Error(`"${target.label}" is a light: set its colour temperature with setKelvin().`);
    const normal = normalizeHex(hex);
    if (!normal) throw new Error(`"${hex}" is not a #rrggbb colour.`);
    return void commit(`color:${id}`, () => { current.colors[id] = normal; hint = null; }, { coalesce: true });
  }

  function setFinish(id, roughness) {
    const target = group(id);
    if (!target.finish) throw new Error(`"${target.label}" has no matte/satin finish.`);
    if (typeof roughness !== 'number' || !Number.isFinite(roughness)) throw new Error('Finish needs a roughness number.');
    const value = clamp(roughness, target.finish.min, target.finish.max);
    return void commit(`finish:${id}`, () => { current.finishes[id] = value; hint = null; }, { coalesce: true });
  }

  function setKelvin(kelvin) {
    if (!lightGroup?.kelvin) throw new Error('This room has no adjustable light.');
    if (typeof kelvin !== 'number' || !Number.isFinite(kelvin)) throw new Error('Colour temperature needs a number of kelvin.');
    const value = clamp(Math.round(kelvin), lightGroup.kelvin.min, lightGroup.kelvin.max);
    return void commit('kelvin', () => { current.kelvin = value; hint = null; }, { coalesce: true });
  }

  function applyPreset(id) {
    const found = resolvedPresets.find(({ preset }) => preset.id === id);
    if (!found) throw new Error(`Unknown palette preset "${id}".`);
    return void commit(`preset:${id}`, () => { current = clone(found.resolved); hint = id; });
  }

  function reset(id) {
    if (id === undefined) return void commit('reset', () => { current = clone(defaults); hint = null; });
    const target = group(id);
    return void commit(`reset:${id}`, () => {
      if (target.kind === 'light') current.kelvin = defaults.kelvin;
      else current.colors[id] = defaults.colors[id];
      if (target.finish) current.finishes[id] = defaults.finishes[id];
      hint = null;
    });
  }

  // A harmonious draw from the curated swatches: one anchor hue, neutrals and nearby hues preferred, one accent group free.
  function randomize(seed = (Math.random() * 0x100000000) >>> 0) {
    const rng = mulberry32(seed);
    const anchor = rng() * 360;
    const accents = recolor.filter(group => group.category === 'bed' || group.category === 'textiles');
    const accent = accents.length ? accents[Math.floor(rng() * accents.length)].id : null;
    const draw = {};
    for (const target of recolor) {
      const swatches = (target.swatches ?? []).filter(swatch => normalizeHex(swatch.hex));
      if (!swatches.length) continue;
      const weights = swatches.map(swatch => {
        if (target.id === accent) return 1;
        const { h, s } = hexHsl(swatch.hex);
        if (s < 0.15) return 1;
        const distance = Math.abs(((h - anchor + 540) % 360) - 180);
        return distance <= 40 ? 1 : distance <= 70 ? 0.5 : 0.08;
      });
      let pick = rng() * weights.reduce((sum, weight) => sum + weight, 0);
      let chosen = swatches.length - 1;
      for (let i = 0; i < weights.length; i++) { pick -= weights[i]; if (pick <= 0) { chosen = i; break; } }
      draw[target.id] = normalizeHex(swatches[chosen].hex);
    }
    const finishes = {};
    for (const target of recolor) {
      if (target.finish && rng() < 0.5) finishes[target.id] = Math.round((target.finish.min + rng() * (target.finish.max - target.finish.min)) * 100) / 100;
    }
    const kelvin = lightGroup?.kelvin ? Math.round((lightGroup.kelvin.min + rng() * (lightGroup.kelvin.max - lightGroup.kelvin.min)) / 50) * 50 : null;
    commit('randomize', () => {
      current = clone(defaults);
      Object.assign(current.colors, draw);
      Object.assign(current.finishes, finishes);
      if (kelvin !== null) current.kelvin = clamp(kelvin, lightGroup.kelvin.min, lightGroup.kelvin.max);
      hint = null;
    });
    return seed >>> 0;
  }

  function travel(from, to) {
    if (disposed || !from.length) return false;
    const before = snapshot();
    restore(from.pop());
    to.push(before);
    comparing = false;
    lastEdit = null;
    dropHash();
    applyUniforms();
    schedulePersist();
    notify();
    return true;
  }
  const undo = () => travel(past, future);
  const redo = () => travel(future, past);

  function compare(on) {
    if (disposed) return;
    const next = !!on;
    if (next === comparing) return;
    comparing = next;
    applyUniforms();
    notify();
  }

  // ---- import / export / share
  function parseState(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A palette must be a JSON object.');
    if (input.version !== version) throw new Error(`Unsupported palette version ${JSON.stringify(input.version)}; this viewer reads version ${version}.`);
    const parsed = clone(defaults);
    const seen = (input.colors && typeof input.colors === 'object' && !Array.isArray(input.colors)) ? input.colors : null;
    if (input.colors !== undefined && !seen) throw new Error('"colors" must be an object of group id to #rrggbb.');
    for (const [id, value] of Object.entries(seen ?? {})) {
      const target = byId.get(id);
      if (!target || target.kind !== 'recolor') continue;
      const normal = normalizeHex(value);
      if (!normal) throw new Error(`Colour for "${target.label}" is not a #rrggbb value.`);
      parsed.colors[id] = normal;
    }
    if (input.finishes !== undefined && (!input.finishes || typeof input.finishes !== 'object' || Array.isArray(input.finishes))) throw new Error('"finishes" must be an object of group id to roughness.');
    for (const [id, value] of Object.entries(input.finishes ?? {})) {
      const target = byId.get(id);
      if (!target?.finish) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < target.finish.min - 1e-6 || value > target.finish.max + 1e-6) {
        throw new Error(`Finish for "${target.label}" must be a number from ${target.finish.min} to ${target.finish.max}.`);
      }
      parsed.finishes[id] = clamp(value, target.finish.min, target.finish.max);
    }
    if (input.kelvin !== undefined) {
      if (typeof input.kelvin !== 'number' || !Number.isFinite(input.kelvin)) throw new Error('"kelvin" must be a number.');
      if (lightGroup?.kelvin) {
        if (input.kelvin < lightGroup.kelvin.min - 1e-6 || input.kelvin > lightGroup.kelvin.max + 1e-6) throw new Error(`Colour temperature must be from ${lightGroup.kelvin.min} to ${lightGroup.kelvin.max} K.`);
        parsed.kelvin = clamp(Math.round(input.kelvin), lightGroup.kelvin.min, lightGroup.kelvin.max);
      }
    }
    const presetId = typeof input.preset === 'string' && presetById.has(input.preset) ? input.preset : null;
    return { parsed, presetId };
  }

  function importJSON(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Paste a palette JSON first.');
    if (text.length > MAX_PAYLOAD_CHARS) throw new Error('That palette is too large to be a room palette.');
    let input;
    try { input = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
    const { parsed, presetId } = parseState(input);
    commit('import', () => { current = parsed; hint = presetId; });
  }

  const exportJSON = () => JSON.stringify(exportObject(), null, 2);

  function shareURL() {
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    params.set(HASH_KEY, encodeState(exportObject()));
    url.hash = params.toString();
    return url.toString();
  }

  // ---- initial state: #palette= first, then localStorage, then the authored defaults
  function loadInitial() {
    const sources = [];
    try { const encoded = location ? hashPayload(location.hash) : null; if (encoded) sources.push(['hash', () => decodeState(encoded)]); } catch { /* ignore */ }
    if (storage) sources.push(['storage', () => { const raw = storage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; }]);
    for (const [origin, read] of sources) {
      try {
        const input = read();
        if (input === null || input === undefined) continue;
        const { parsed, presetId } = parseState(input);
        current = parsed;
        hint = presetId;
        hashConsumed = origin === 'hash';
        return origin;
      } catch (error) { console.warn(`Ignoring the saved palette (${origin}): ${error.message}`); }
    }
    return 'defaults';
  }
  const source = loadInitial();
  applyUniforms();

  return {
    groups, presets, source, unmatched,
    state, setColor, setFinish, setKelvin, applyPreset, reset, randomize,
    undo, redo, canUndo: () => past.length > 0, canRedo: () => future.length > 0, compare,
    exportJSON, importJSON, shareURL, flush,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      subscribers.clear();
    },
  };
}

// Reading window.localStorage throws in some privacy modes; the palette then simply is not remembered.
function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
