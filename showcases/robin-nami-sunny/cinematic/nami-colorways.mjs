import { CanvasTexture, Color, SRGBColorSpace } from 'three';
import { TRANSITION, REDUCED_TRANSITION } from './nami-cloth/garment.mjs';
import { attachWitchHat } from './nami-halloween-props.mjs';

// Nami's colour is painted into one shared atlas, so a colorway re-hues pixels instead of
// swapping geometry. Each target has its own hue gate, so only that garment's pixels move:
//   top     = green fabric  (applied by the garment shader, with its fold/recolor animation)
//   jeans   = denim blue    (Jeans uses its own copy of the atlas)
//   sandals = orange straps (shoes/shoes.001 use their own copy of the atlas)
// A spec is { hue: degrees | null (keep), sat: multiplier, val: multiplier }.
export const COLORWAYS = Object.freeze([
  { id: 'classic', label: 'Classic green', swatch: '#2f9a6c', top: null, jeans: null, sandals: null },
  { id: 'sunset', label: 'Sunset orange', swatch: '#e0782b', top: { hue: 22, sat: 1.05, val: 1.18 }, jeans: null, sandals: null },
  { id: 'rose', label: 'Rose pink', swatch: '#d9628f', top: { hue: 338, sat: 1, val: 1.12 }, jeans: { hue: null, sat: 1, val: 0.74 }, sandals: { hue: 345, sat: .8, val: 1.1 } },
  { id: 'violet', label: 'Violet night', swatch: '#7a52c7', top: { hue: 266, sat: 1, val: 1.02 }, jeans: { hue: 250, sat: .8, val: 0.62 }, sandals: { hue: 275, sat: .9, val: 1 } },
  { id: 'aqua', label: 'Aqua breeze', swatch: '#2ab7c9', top: { hue: 186, sat: .95, val: 1.1 }, jeans: { hue: null, sat: .55, val: 1.25 }, sandals: { hue: 190, sat: .9, val: 1.05 } },
  { id: 'midnight', label: 'Midnight black', swatch: '#2a2f45', top: { hue: 232, sat: .85, val: .62 }, jeans: { hue: null, sat: .22, val: 0.34 }, sandals: { hue: null, sat: .1, val: 0.4 } },
  // Pumpkin-orange top, purple-black jeans, black sandals and a witch hat.
  { id: 'halloween', label: 'Halloween witch', swatch: '#e8741c', top: { hue: 26, sat: 1.12, val: .96 }, jeans: { hue: 278, sat: .72, val: 0.5 }, sandals: { hue: null, sat: .15, val: 0.3 }, witchHat: true },
]);
export const TOP_SPECS = Object.freeze(Object.fromEntries(COLORWAYS.map(c => [c.id, c.top])));

const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max, max];
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}
// Hue/saturation gates keep skin, hair, line work, white stripes and shading untouched.
const GATES = Object.freeze({
  jeans: (h, s) => smooth(0.12, 0.28, s) * smooth(170, 190, h) * (1 - smooth(255, 275, h)),
  sandals: (h, s) => smooth(0.3, 0.5, s) * smooth(2, 12, h) * (1 - smooth(38, 52, h)),
});
function recolor(data, gate, spec) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const [h, s, v] = rgbToHsv(r, g, b);
    const weight = gate(h, s);
    if (weight === 0) continue;
    const [nr, ng, nb] = hsvToRgb(spec.hue ?? h, Math.min(1, s * spec.sat), Math.min(1, v * spec.val));
    data[i] = Math.round((r + (nr - r) * weight) * 255);
    data[i + 1] = Math.round((g + (ng - g) * weight) * 255);
    data[i + 2] = Math.round((b + (nb - b) * weight) * 255);
  }
}

/**
 * Applies colorways to a loaded Nami. The top goes through the garment's own
 * fold-and-recolor transition; jeans and sandals swap at the moment that transition recolors,
 * so the whole outfit changes together.
 */
export function createWardrobe({ entity, garments, anisotropy = 1, reducedMotion = false }) {
  const find = name => { let found = null; entity.traverse(node => { if (node.isMesh && node.name === name) found = node; }); return found; };
  const targets = {
    jeans: [find('Jeans')].filter(Boolean),
    sandals: ['shoes', 'shoes.001'].map(find).filter(Boolean),
  };
  for (const [kind, meshes] of Object.entries(targets)) if (!meshes.length) throw new Error(`Wardrobe: no ${kind} mesh in the Nami scene`);
  const originals = new Map(Object.values(targets).flat().map(mesh => [mesh, mesh.material]));
  const cache = new Map(), owned = [];
  let current = COLORWAYS[0].id, pending = null, hat = null;
  const tint = new Color(1, 1, 1);
  const lightingTargets = () => [...originals.values(), ...cache.values()];
  function showHat(visible) {
    if (visible && !hat) {
      const bones = []; entity.traverse(node => { if (node.isBone && node.name === 'Nami_Head') bones.push(node); });
      const hair = find('Hair');
      if (bones.length !== 1 || !hair) throw new Error('Wardrobe: the witch hat needs Nami_Head and Hair');
      hat = attachWitchHat({ entity, headBone: bones[0], hair });
    }
    if (hat) hat.object.visible = visible;
  }

  function repainted(kind, mesh, spec) {
    const key = `${kind}:${JSON.stringify(spec)}`;
    if (!cache.has(key)) {
      const original = originals.get(mesh), image = original.map?.image;
      if (!image) throw new Error(`Wardrobe: ${mesh.name} has no painted atlas`);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      recolor(pixels.data, GATES[kind], spec); context.putImageData(pixels, 0, 0);
      const texture = new CanvasTexture(canvas);
      texture.flipY = original.map.flipY; texture.colorSpace = SRGBColorSpace; texture.anisotropy = anisotropy; texture.channel = original.map.channel;
      texture.wrapS = original.map.wrapS; texture.wrapT = original.map.wrapT;
      const material = original.clone(); material.map = texture; material.needsUpdate = true;
      owned.push(texture, material); cache.set(key, material);
    }
    return cache.get(key);
  }
  function paint(id) {
    const way = COLORWAYS.find(c => c.id === id);
    for (const kind of ['jeans', 'sandals']) {
      for (const mesh of targets[kind]) {
        mesh.material = way[kind] ? repainted(kind, mesh, way[kind]) : originals.get(mesh);
        if (mesh.material.color) mesh.material.color.copy(tint);
      }
    }
    showHat(Boolean(way.witchHat));
    current = id;
  }
  return {
    get current() { return current; },
    get busy() { return Boolean(pending) || garments.transitioning; },
    /** Starts a change; false when the garment cannot transform right now (mid-transition or grabbed). */
    apply(id) {
      if (!COLORWAYS.some(c => c.id === id)) throw new Error(`Unknown Nami colorway: ${id}`);
      if (id === current && !pending) return false;
      if (pending || !garments.transformTo(id)) return false;
      // Wait until the top's recolor morph begins (instant when there is no fold animation).
      const animated = garments.transitioning;
      pending = { id, wait: animated ? (reducedMotion ? REDUCED_TRANSITION.morph[0] : TRANSITION.morph[0]) : 0, elapsed: 0 };
      if (!animated) this.update(0);
      return true;
    },
    update(dt) {
      if (!pending) return;
      pending.elapsed += dt;
      if (pending.elapsed >= pending.wait) { paint(pending.id); pending = null; }
    },
    snapshot: () => ({ current, pending: pending?.id ?? null, garment: garments.outfit, witchHat: Boolean(hat?.object.visible) }),
    /** Multiplies every unlit painted material (her atlas is unlit) so she darkens with the scene. */
    setTint(color) {
      tint.copy(color);
      for (const material of lightingTargets()) if (material.isMeshBasicMaterial) material.color.copy(tint);
    },
    dispose() {
      for (const mesh of originals.keys()) mesh.material = originals.get(mesh);
      for (const item of owned) item.dispose();
      hat?.dispose(); hat = null;
      cache.clear(); owned.length = 0; pending = null;
    },
  };
}
