import { Color } from 'three';

// Painted characters are lit by a handful of scene lights, so far from a lantern a lit skin or cloth
// falls to black at night while unlit parts (Nami's atlas) stay readable. This adds a soft self-lit
// term equal to the scene tint times the albedo, zero in daylight, so every material reads the same.
const lists = new WeakMap(), originals = new WeakMap(), last = new WeakMap();
const glow = new Color();

function materialsOf(root) {
  if (!lists.has(root)) {
    const found = new Set();
    root.traverse(node => {
      if (!node.isMesh) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        // Only plain painted materials: anything already emissive (eyes, glows) is left alone.
        if (material.isMeshStandardMaterial && material.map && material.emissive.getHex() === 0 && !material.emissiveMap) found.add(material);
      }
    });
    lists.set(root, [...found]);
  }
  return lists.get(root);
}

/** `tint` is the scene light multiplier (white in daylight). Cheap to call every frame. */
export function applyNightFill(root, tint) {
  const strength = Math.max(0, 1 - (tint.r + tint.g + tint.b) / 3) * 0.9;
  const key = Math.round(strength * 500) * 1000 + Math.round(tint.b * 100);
  if (last.get(root) === key) return;
  last.set(root, key);
  glow.copy(tint).multiplyScalar(strength);
  for (const material of materialsOf(root)) {
    if (!originals.has(material)) originals.set(material, { map: material.map });
    const wanted = strength > 0 ? originals.get(material).map : null;
    if (material.emissiveMap !== wanted) { material.emissiveMap = wanted; material.needsUpdate = true; }
    material.emissive.copy(strength > 0 ? glow : new Color(0));
  }
}
