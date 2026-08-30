/**
 * Take the shoulders off the face.
 *
 * THE DEFECT. The generated rig weights the head to the CLAVICLES. Measured over the 24,373
 * vertices whose dominant joint is `Head` or one of its descendants:
 *
 *   Head          0.783 of the total weight
 *   L_Clavicle    0.106      <- the left shoulder
 *   R_Clavicle    0.096      <- the right shoulder
 *   Spine01       0.009
 *   Spine02       0.005
 *
 * So roughly a fifth of the head rides the shoulders, and on individual vertices it is far worse:
 * the largest share held by a non-dominant joint on an iris vertex is **0.581**. The clavicles
 * rotate on nearly every clip, because that is what a clavicle is for — so every arm swing drags a
 * fifth of the face with it. On flat fur that reads as a wobble and is easy to miss. On the eyes
 * and the fangs it is obvious, because those are features that have to stay RIGID: an eyeball
 * split between two joints that rotate apart stops being a solid object and becomes a blend of
 * two, which is what a torn sclera and a sheared fang actually are.
 *
 * THE FIX, and its limits. This is skin conditioning, not measurement: it OVERWRITES weights that
 * came out of the generator. That is worth stating plainly, and it is justified narrowly — a head
 * does not follow a shoulder in any anatomy, so clavicle influence on head vertices is not a
 * modelling choice being second-guessed, it is spill from an automatic rigger.
 *
 * What it removes is only the arm chain, and only from vertices the head already dominates. Spine
 * and neck influence is left exactly as it was, because a head genuinely does follow those.
 *
 * The redistribution is proportional across the joints that remain, so the balance the generator
 * chose between `Head`, `NeckTwist02` and `Spine01` survives — only the arm's share is handed back.
 */
import * as THREE from 'three';
import type { EncodedRig } from './meshCodec';

export interface SkinFixReport {
  /** Vertices whose binding was rewritten. */
  verticesChanged: number;
  /** The largest single weight taken off one vertex. */
  maxWeightMoved: number;
  /** Total weight removed across the whole mesh, as a fraction of one vertex. */
  totalWeightMoved: number;
  jointsRemoved: string[];
  /** Gate G4 after the rewrite: every vertex must still sum to 1. */
  maxWeightErrorAfter: number;
  /** Gate G5 after the rewrite. */
  maxSkinIndexAfter: number;
}

export function conditionHeadSkin(mesh: THREE.SkinnedMesh, rig: EncodedRig): SkinFixReport {
  const names = rig.bones.map((b) => b.name);
  const indexOf = new Map(names.map((n, i) => [n, i]));

  const descendsFrom = (name: string, ancestor: string): boolean => {
    let i = indexOf.get(name);
    while (i !== undefined && i >= 0) {
      if (names[i] === ancestor) return true;
      const parent: number = rig.bones[i].parent;
      if (parent < 0) return false;
      i = parent;
    }
    return false;
  };

  /** The head and anything hanging off it — the vertices this pass is allowed to touch. */
  const headSet = new Set(names.filter((n) => n === 'Head' || descendsFrom(n, 'Head')));
  /**
   * The arm chains, clavicle included. The clavicle IS the joint at fault, so excluding it and
   * removing only its children would leave the whole problem in place.
   */
  const armSet = new Set(names.filter((n) => descendsFrom(n, 'L_Clavicle') || descendsFrom(n, 'R_Clavicle')));

  const skinIndex = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = mesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const count = skinIndex.count;

  const removed = new Set<string>();
  let verticesChanged = 0;
  let maxWeightMoved = 0;
  let totalWeightMoved = 0;

  for (let v = 0; v < count; v += 1) {
    // Which joint holds this vertex? Only faces are in scope.
    let dominant = -1;
    let dominantWeight = -1;
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight.getComponent(v, k);
      if (w > dominantWeight) { dominantWeight = w; dominant = skinIndex.getComponent(v, k); }
    }
    if (dominant < 0 || !headSet.has(names[dominant])) continue;

    let moved = 0;
    let kept = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight.getComponent(v, k);
      if (w <= 0) continue;
      if (armSet.has(names[skinIndex.getComponent(v, k)])) { moved += w; removed.add(names[skinIndex.getComponent(v, k)]); }
      else kept += w;
    }
    if (moved <= 0) continue;

    if (kept <= 1e-6) {
      // Nothing left to carry the vertex. Give it entirely to its dominant joint rather than
      // leaving it unweighted, which would collapse it to the origin.
      for (let k = 0; k < 4; k += 1) {
        const isDominant = skinIndex.getComponent(v, k) === dominant && skinWeight.getComponent(v, k) === dominantWeight;
        skinWeight.setComponent(v, k, isDominant ? 1 : 0);
      }
    } else {
      // Proportional: the split the generator chose between the joints that stay is preserved.
      const scale = 1 / kept;
      for (let k = 0; k < 4; k += 1) {
        const w = skinWeight.getComponent(v, k);
        if (w <= 0) continue;
        skinWeight.setComponent(v, k, armSet.has(names[skinIndex.getComponent(v, k)]) ? 0 : w * scale);
      }
    }

    verticesChanged += 1;
    totalWeightMoved += moved;
    maxWeightMoved = Math.max(maxWeightMoved, moved);
  }

  skinWeight.needsUpdate = true;

  // Re-run the two gates this pass could break, on the rewritten data rather than on the original.
  let maxWeightErrorAfter = 0;
  let maxSkinIndexAfter = 0;
  for (let v = 0; v < count; v += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      sum += skinWeight.getComponent(v, k);
      maxSkinIndexAfter = Math.max(maxSkinIndexAfter, skinIndex.getComponent(v, k));
    }
    maxWeightErrorAfter = Math.max(maxWeightErrorAfter, Math.abs(1 - sum));
  }

  return {
    verticesChanged,
    maxWeightMoved: Number(maxWeightMoved.toFixed(4)),
    totalWeightMoved: Number(totalWeightMoved.toFixed(2)),
    jointsRemoved: [...removed].sort(),
    maxWeightErrorAfter,
    maxSkinIndexAfter,
  };
}
