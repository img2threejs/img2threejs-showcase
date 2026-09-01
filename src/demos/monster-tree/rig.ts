import * as THREE from 'three';
import {
  buildClips,
  buildSkeleton,
  decodeFloats,
  decodeModel,
  decodeUint16s,
  type EncodedModel,
  type EncodedRig,
} from './meshCodec';
import { ALBEDO_WHITE_BALANCE, COSTUME_PIECES, COSTUME_RLE, COSTUME_RLE_TRIANGLES, SOCKETS } from './measured';

export type SocketKind = 'effect' | 'grip' | 'attachment';

/**
 * Branch stock lifted out of the character's own upper body.
 *
 * Everything this demo grows out of the ground — roots, groves, the lance — was generated from
 * tapered cylinders, which gave the right proportions and the wrong shape: smooth, round, and
 * nothing like the gnarled forms the figure is actually made of. This takes the geometry instead
 * of imitating it.
 *
 * The source is the CROWN, above y 0.90 — the thin dry twigs over the skull. Measured by slicing
 * the crown into horizontal slabs and sizing each twig's cross-section, they run 0.0140 radius at
 * the base down to 0.0038 at the tips: genuinely slender dead wood, tapering to about a quarter of
 * its base.
 *
 * The shoulder spur cluster was tried first and was wrong. It is a real branch off the torso, but
 * extracting it drags a lump of shoulder mass along with it, and 2,526 triangles of body wall
 * instanced on a trunk reads as a slab, not a twig. Thinness is what makes wood read as a branch,
 * and the shoulder had none to give.
 *
 * Normalised to unit height with its base at the origin, so an instance is placed by scale and
 * rotation alone.
 */
function extractBranchStock(
  index: Uint32Array,
  position: Float32Array,
  normal: Float32Array,
  colour: Float32Array,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  boneNames: string[],
): THREE.BufferGeometry | null {
  const dominant = (v: number): string => {
    let best = -1;
    let bone = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight[v * 4 + k];
      if (w > best) { best = w; bone = skinIndex[v * 4 + k]; }
    }
    return boneNames[bone];
  };
  const inStock = (v: number): boolean =>
    dominant(v) === 'Head' && position[v * 3 + 1] > 0.90;

  const keep = new Set<number>();
  for (let v = 0; v < position.length / 3; v += 1) if (inStock(v)) keep.add(v);
  const { geometry, kept } = extractTriangles(
    (f) => keep.has(index[f * 3]) && keep.has(index[f * 3 + 1]) && keep.has(index[f * 3 + 2]),
    index, position, normal, colour, null, null, null,
  );
  if (!kept.length) return null;

  // Stand it up: base at the origin, unit height, so instancing is scale and rotation only.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const height = Math.max(1e-4, box.max.y - box.min.y);
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  geometry.scale(1 / height, 1 / height, 1 / height);

  // Grain along the branch, so the bark shader treats it as a limb like every other.
  const count = geometry.attributes.position.count;
  const grain = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) grain[i * 3 + 1] = 1;
  geometry.setAttribute('aGrain', new THREE.BufferAttribute(grain, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One rigid costume piece: its own mesh, riding a least-squares rigid fit, never skinned. */
export interface CostumePiece {
  id: string;
  label: string;
  /** The bone the piece is named for — the dominant entry of `blend`. */
  bone: string;
  mesh: THREE.Mesh;
  triangles: number;
  /** How many vertices the per-frame rigid fit is solved against. */
  fitSamples: number;
}

export interface MonsterTreeRig {
  /** Scene-ready root. Transform this freely — the skinning is invariant under it (see `bind`). */
  group: THREE.Group;
  /** The bark body: the only mesh that deforms. */
  shell: THREE.SkinnedMesh;
  /** Leather bracers and gauntlets — separate meshes, rigidly fitted to the skeleton. */
  costume: CostumePiece[];
  skeleton: THREE.Skeleton;
  /** Every bone by its real rig name. */
  bones: Record<string, THREE.Bone>;
  /** Effect / grip / attachment anchors, parented to the bone each one was measured against. */
  sockets: Record<string, THREE.Object3D>;
  /**
   * A branch taken off the character's own shoulder, normalised to unit height with its base at
   * the origin. Anything the demo grows instances this rather than approximating it.
   */
  branchStock: THREE.BufferGeometry | null;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  /** Cross-fade to a clip by name or index. Returns false when there is no such clip. */
  play(clip: string | number, fadeSeconds?: number): boolean;
  /** The clip currently faded in, or null before the first `play`. */
  current(): string | null;
  /** Advance the animation. Takes the frame DELTA in seconds, never elapsed time. */
  update(deltaSeconds: number): void;
  /**
   * Hitstop: hold the clip nearly still for a few tens of milliseconds.
   *
   * This is most of what an impact feels like, and none of it is a particle. A blow that lands
   * while the animation keeps running at full speed reads as the effects happening NEAR the
   * character; the same blow with the clip arrested for 70 ms reads as the character having hit
   * something. It is applied to the mixer's own delta rather than to a global clock, so the
   * effects, the ambient drift and the camera all keep running while the body stops.
   *
   * `scale` is how slowly time runs during the hold — 0.08 is near-frozen, 1 is normal.
   */
  hitstop(seconds: number, scale?: number): void;
  /**
   * Re-apply the current stretches to the skeleton.
   *
   * Call this exactly ONCE per frame, after whatever sets the stretches. The mixer rewrites every
   * bone's scale on each `update`, so this must come after it; and because it MULTIPLIES the
   * clip's value rather than replacing it, calling it twice in a frame squares the factor.
   */
  applyStretch(): void;

  /**
   * Lengthen a bone along its own axis, on top of whatever the clip is doing.
   *
   * `amount` is extra length as a fraction: 1 doubles the segment. Set it every frame; it is not
   * a tween and it does not persist, because the clip overwrites the bone's scale on every
   * `mixer.update` and this has to be reapplied after.
   */
  stretch(bone: string, amount: number): void;
  /**
   * Point a bone's segment along a direction, on top of whatever the clip is doing.
   *
   * `direction` is in the FIGURE's own frame — forward +X, up +Y, its left -Z, measured off the
   * eye clusters in `model.ts` — and is converted to world internally, so an authored gesture
   * survives the viewer spinning the turntable. `weight` blends between the clip's own value (0)
   * and the aimed one (1), so a gesture can take an arm without taking the body with it.
   *
   * Set it every frame; like `stretch` it does not persist, because the mixer overwrites every
   * bone's rotation on each `update`.
   */
  aim(bone: string, direction: THREE.Vector3 | null, weight?: number): void;
  /**
   * Re-apply the current aims. Call once per frame, after `update` and before `applyStretch`.
   *
   * Parents first, accumulating world rotations as it goes: a bone's aim is solved against where
   * its parent has ALREADY been put this frame, so aiming a shoulder and then the elbow off it
   * composes the way a limb does rather than fighting.
   */
  applyPose(): void;
  /**
   * Author a clip of a given length that keeps the body alive underneath a gesture.
   *
   * A trimmed copy of `standing_relax` — the quietest clip in the library — registered under a new
   * name. The gesture on top comes from `aim`; this supplies the duration the runner needs, the
   * breathing, and the weight shifts nobody wants to hand-author.
   */
  authorClip(name: string, duration: number, fromSeconds?: number): THREE.AnimationClip;
  /**
   * Build an independent copy of the figure that can be posed at its own point in a clip.
   *
   * A second skinned shell with its OWN skeleton and its OWN mixer, sharing the original's
   * geometry — 101,466 triangles are not duplicated, only the ~60 bones and the bone texture are.
   * Because the skeleton is separate, an echo can stand at a different frame of the same clip from
   * the figure that cast it, which is the whole point: five copies all locked to the original's
   * playhead are one pose seen five times, and that reads as a mirror artifact rather than as
   * five bodies.
   *
   * Move the echo by transforming `object`. The skinning is invariant under the mesh's own
   * transform (AttachedBindMode cancels it), so the transform has to land on the group that
   * carries the BONES — which is what `object` is.
   */
  makeEcho(material: THREE.Material): RigEcho;
  dispose(): void;
}

/** One independently posed copy of the figure. See `MonsterTreeRig.makeEcho`. */
export interface RigEcho {
  /** Transform this to place the echo. Add it to the scene yourself. */
  object: THREE.Group;
  mesh: THREE.SkinnedMesh;
  /** Pose this copy at an absolute time inside a clip. Clamped into the clip. */
  seek(clip: string, seconds: number): void;
  dispose(): void;
}

export interface RigOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Skip the costume split and keep one skinned shell (for A/B against the raw export). */
  fuseCostume?: boolean;
  /**
   * Play clips in place: hold the hip's horizontal travel, keep its vertical. Default true.
   *
   * These clips carry root motion on `Hip` — `front_kick_01` moves it 0.431 rig units and
   * `dance_01` 0.864 — so on a fixed camera the figure simply walks out of frame partway through
   * the move you pressed the button to see. Set false to get the clips exactly as retargeted.
   */
  inPlace?: boolean;
}

/**
 * Neutralise a clip's horizontal root motion, leaving its vertical alone.
 *
 * Only `Hip` carries translation in this rig, and its track is expressed in `Root`'s local frame,
 * not in world space. Root's rest quaternion is (-0.5, 0.5, 0.5, 0.5), which maps a local
 * (a, b, c) to world (-b, c, -a) — so the hip's local Z is world UP and its local X and Y are the
 * two horizontal axes. Pinning components 0 and 1 to their first-frame values stops the drift
 * while leaving the crouch in a kick and the drop in `defeat_03` (local Z range 0.412) intact.
 *
 * Zeroing all three instead would pin the figure's pelvis at a fixed height and make every one of
 * those moves slide rather than settle.
 */
function holdRootMotion(clips: THREE.AnimationClip[], hipBone: string): void {
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (track.name !== `${hipBone}.position`) continue;
      const values = track.values as Float32Array;
      const [x0, y0] = [values[0], values[1]];
      for (let i = 0; i < values.length; i += 3) {
        values[i] = x0;
        values[i + 1] = y0;
      }
    }
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 -> binary string. Written out rather than reaching for `atob`/`Buffer`, so this module
 * behaves identically in the browser bundle and under node in `tools/measure-rig.mjs`. */
function decodeBase64Text(text: string): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = B64.indexOf(text[i]);
    if (c < 0) continue;
    value = (value << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/** Expand the run-length costume map into one piece code per triangle. */
function decodeCostumeMap(rle: string, triangleCount: number): Uint8Array {
  const binary = decodeBase64Text(rle);
  const out = new Uint8Array(triangleCount);
  let at = 0;
  let write = 0;
  while (at < binary.length) {
    const code = binary.charCodeAt(at);
    at += 1;
    let run = 0;
    let shift = 1;
    for (;;) {
      const byte = binary.charCodeAt(at);
      at += 1;
      run += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    if (write + run > triangleCount) throw new Error('costume map: run overruns the triangle count');
    out.fill(code, write, write + run);
    write += run;
  }
  if (write !== triangleCount) throw new Error(`costume map: covered ${write} of ${triangleCount} triangles`);
  return out;
}

/**
 * Pull one subset of triangles out of a shared vertex pool into its own geometry.
 *
 * Vertices are re-indexed rather than copied wholesale, so a piece carries only the vertices its
 * own triangles touch. Positions stay in the original bind-pose space — that is what lets a piece
 * be placed by its bone's inverse bind matrix instead of a hand-tuned offset.
 */
function extractTriangles(
  keep: (triangle: number) => boolean,
  index: Uint32Array,
  position: Float32Array,
  normal: Float32Array,
  colour: Float32Array,
  skinIndex: Uint16Array | null,
  skinWeight: Float32Array | null,
  grain: Float32Array | null,
): { geometry: THREE.BufferGeometry; kept: number[] } {
  const remap = new Int32Array(position.length / 3).fill(-1);
  const kept: number[] = [];
  const triangles: number[] = [];
  for (let f = 0; f < index.length / 3; f += 1) {
    if (!keep(f)) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = index[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = kept.length;
        kept.push(v);
      }
      triangles.push(remap[v]);
    }
  }

  const n = kept.length;
  const geometry = new THREE.BufferGeometry();
  const p = new Float32Array(n * 3);
  const nm = new Float32Array(n * 3);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const v = kept[i];
    for (let k = 0; k < 3; k += 1) {
      p[i * 3 + k] = position[v * 3 + k];
      nm[i * 3 + k] = normal[v * 3 + k];
      c[i * 3 + k] = colour[v * 3 + k];
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nm, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(c, 3));

  if (skinIndex && skinWeight) {
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      const v = kept[i];
      for (let k = 0; k < 4; k += 1) {
        si[i * 4 + k] = skinIndex[v * 4 + k];
        sw[i * 4 + k] = skinWeight[v * 4 + k];
      }
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }

  if (grain) {
    const gr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const v = kept[i];
      gr[i * 3] = grain[v * 3];
      gr[i * 3 + 1] = grain[v * 3 + 1];
      gr[i * 3 + 2] = grain[v * 3 + 2];
    }
    geometry.setAttribute('aGrain', new THREE.BufferAttribute(gr, 3));
  }

  const Index = n <= 65535 ? Uint16Array : Uint32Array;
  geometry.setIndex(new THREE.BufferAttribute(Index.from(triangles), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, kept };
}

/**
 * The direction wood grain runs at every vertex, taken from the rig rather than invented.
 *
 * Each bone's axis is measured in BIND space, bone position to child position — `L_Forearm` comes
 * out [0.00, 0.00, -1.00] (along the arm), `L_Thigh` [-0.09, -0.99, -0.11] (down the leg),
 * `Spine02` [-0.02, 0.96, -0.29] (up the torso). A vertex takes the axis of the bone it is most
 * strongly weighted to, so the grain in `bark.ts` elongates along whichever limb the vertex
 * belongs to. That is what makes the wood read as body parts instead of one carved plank.
 *
 * Two details:
 *  - Twist helpers are skipped when choosing a bone's child. `L_Forearm` has both `L_ForearmTwist01`
 *    and `L_Hand` as children; the twist bone sits at the SAME position as its parent, so picking it
 *    would give a zero-length axis for exactly the bones whose direction matters most.
 *  - A leaf bone has no child to aim at, so it inherits the direction from its parent instead. 13
 *    of the 41 bones resolve this way. `Hip` is the one genuinely degenerate case — `Pelvis` sits on
 *    top of it — and falls back to +Y, which is the right answer for a hip regardless.
 */
function grainDirections(
  rig: EncodedRig,
  skeleton: THREE.Skeleton,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  vertexCount: number,
): Float32Array {
  const bindPosition = skeleton.boneInverses.map((m) =>
    new THREE.Vector3().setFromMatrixPosition(m.clone().invert()));

  const children: number[][] = rig.bones.map(() => []);
  rig.bones.forEach((b, i) => { if (b.parent >= 0) children[b.parent].push(i); });

  const axis = rig.bones.map((bone, i) => {
    const kids = children[i];
    const solid = kids.filter((k) => !/Twist/.test(rig.bones[k].name));
    const target = solid.length ? solid[0] : (kids.length ? kids[0] : -1);
    const direction = new THREE.Vector3();
    if (target >= 0) direction.subVectors(bindPosition[target], bindPosition[i]);
    else if (bone.parent >= 0) direction.subVectors(bindPosition[i], bindPosition[bone.parent]);
    return direction.lengthSq() > 1e-12 ? direction.normalize() : new THREE.Vector3(0, 1, 0);
  });

  const out = new Float32Array(vertexCount * 3);
  const blended = new THREE.Vector3();
  for (let v = 0; v < vertexCount; v += 1) {
    // The DOMINANT bone only sets the reference direction. The value written is the weighted
    // blend of all four influences, which is what keeps the field continuous.
    //
    // Taking the dominant bone's axis outright makes the grain jump wherever influence hands over
    // from one bone to the next — at the pectorals, the shoulders, the neck. The relief built on
    // top of it then seams along every one of those boundaries, and the figure reads as though a
    // stippled chain were drawn around each muscle group. Blending the axes the same way the skin
    // blends its bones removes the discontinuity at its source.
    let best = -1;
    let dominant = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight[v * 4 + k];
      if (w > best) { best = w; dominant = skinIndex[v * 4 + k]; }
    }
    const reference = axis[dominant];

    blended.set(0, 0, 0);
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const a = axis[skinIndex[v * 4 + k]];
      // Grain is an AXIS, not an arrow: a limb pointing -Z and its neighbour pointing +Z describe
      // the same fibre direction. Averaging them unflipped cancels to zero and the frame collapses,
      // so each term is folded into the dominant bone's hemisphere first.
      const sign = a.dot(reference) < 0 ? -w : w;
      blended.addScaledVector(a, sign);
    }
    const direction = blended.lengthSq() > 1e-10 ? blended.normalize() : reference;
    out[v * 3] = direction.x;
    out[v * 3 + 1] = direction.y;
    out[v * 3 + 2] = direction.z;
  }
  return out;
}

/** One sampled vertex of a costume piece, with the skin binding it had before it was lifted out. */
interface FitSample {
  bind: THREE.Vector3;
  bones: number[];
  weights: number[];
}

/**
 * Sample a piece's vertices for the rigid fit below, and collect the bones they are bound to.
 *
 * A few dozen samples is enough: fitting `bracer-l` on 49 samples and on all 1,734 of its vertices
 * gives 0.05321 and 0.05396 maximum deviation respectively, so the extra 1,685 vertices buy
 * nothing and cost a per-frame skinning pass.
 */
function sampleForFit(
  kept: number[],
  position: Float32Array,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  count = 48,
): { samples: FitSample[]; bones: number[] } {
  const stride = Math.max(1, Math.floor(kept.length / count));
  const samples: FitSample[] = [];
  const used = new Set<number>();
  for (let i = 0; i < kept.length; i += stride) {
    const v = kept[i];
    const bones: number[] = [];
    const weights: number[] = [];
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      bones.push(skinIndex[v * 4 + k]);
      weights.push(w);
      used.add(skinIndex[v * 4 + k]);
    }
    samples.push({
      bind: new THREE.Vector3(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]),
      bones,
      weights,
    });
  }
  return { samples, bones: [...used] };
}

/**
 * The transform a costume piece rides: the least-squares rigid fit to the motion its own vertices
 * WOULD have had if they had stayed skinned.
 *
 * This is the whole trick, and it is worth being precise about why the obvious alternatives lose.
 * Measured across all 16 clips at 7 poses each, as the largest distance between a piece vertex and
 * the skinned position it was lifted from:
 *
 *     piece       nearest bone   blend of its 4 bones   least-squares fit
 *     bracer-l    0.0881         0.2424                 0.0532
 *     bracer-r    0.0497         0.1457                 0.0290
 *     glove-l     0.0118         0.0122                 0.0109
 *     glove-r     0.0000         0.0000                 0.0000
 *
 * Binding to the nearest bone ignores that the bracer's proximal ring is a quarter upper-arm, so
 * the seam stands open during a punch. Blending the four bones' delta TRANSFORMS is worse still —
 * averaging translations of deltas about different centres is not the average of the motion, and
 * the error grows with the distance between the bones. The least-squares fit sidesteps both: it
 * asks directly for the rigid transform closest to the real deformation, which is by definition
 * the best a rigid piece can do, and it spreads the residual over the piece instead of piling it
 * all onto one edge.
 *
 * Rotation comes from the polar decomposition of the covariance matrix, iterated as
 * `R <- (R + R^-T) / 2`. That converges to the orthogonal factor in a handful of steps and needs
 * no SVD, which three does not carry.
 *
 * Scale is FIXED at the rig's normalise scale rather than solved for. Solving it lets the piece
 * breathe with the skin — the best-fit scale swings about 8% over a punch, because linear blend
 * skinning really does compress the inside of a bent elbow — and a leather bracer that shrinks
 * and swells is the very deformation this split exists to remove. Fixing it costs almost nothing
 * in tracking (bracer-l 0.0532 solved vs 0.0537 fixed) and makes the piece rigid by construction:
 * one rotation, one translation, one constant scale, so no two vertices in the piece can change
 * their distance at all.
 */
function rigidFit(samples: FitSample[], posed: THREE.Vector3[], bindCentroid: THREE.Vector3, scale: number, out: THREE.Matrix4): void {
  const n = samples.length;
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < n; i += 1) { px += posed[i].x; py += posed[i].y; pz += posed[i].z; }
  px /= n; py /= n; pz /= n;

  const m = FIT_M;
  m.fill(0);
  for (let i = 0; i < n; i += 1) {
    const ax = samples[i].bind.x - bindCentroid.x;
    const ay = samples[i].bind.y - bindCentroid.y;
    const az = samples[i].bind.z - bindCentroid.z;
    const cx = posed[i].x - px;
    const cy = posed[i].y - py;
    const cz = posed[i].z - pz;
    m[0] += cx * ax; m[1] += cx * ay; m[2] += cx * az;
    m[3] += cy * ax; m[4] += cy * ay; m[5] += cy * az;
    m[6] += cz * ax; m[7] += cz * ay; m[8] += cz * az;
  }

  // Matrix3.set() takes row-major; .elements is column-major, which is what the loop below reads.
  FIT_R.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  let norm = 0;
  for (let k = 0; k < 9; k += 1) norm += m[k] * m[k];
  norm = Math.sqrt(norm / 3) || 1;
  FIT_R.multiplyScalar(1 / norm);
  const r = FIT_R.elements;
  const s = FIT_S.elements;
  for (let it = 0; it < 12; it += 1) {
    FIT_S.copy(FIT_R).invert().transpose();
    for (let k = 0; k < 9; k += 1) r[k] = 0.5 * (r[k] + s[k]);
  }

  out.set(
    r[0] * scale, r[3] * scale, r[6] * scale, px - scale * (r[0] * bindCentroid.x + r[3] * bindCentroid.y + r[6] * bindCentroid.z),
    r[1] * scale, r[4] * scale, r[7] * scale, py - scale * (r[1] * bindCentroid.x + r[4] * bindCentroid.y + r[7] * bindCentroid.z),
    r[2] * scale, r[5] * scale, r[8] * scale, pz - scale * (r[2] * bindCentroid.x + r[5] * bindCentroid.y + r[8] * bindCentroid.z),
    0, 0, 0, 1,
  );
}

/**
 * Minimum seconds between two hitstops.
 *
 * 0.18 is a third of the shortest measured gap between two beats a move is built on (dance_05's
 * arrests come every ~0.35s at their densest, box_02's flurry every 0.167s) — close enough to let
 * a deliberate double-beat through, wide enough that a clip whose table lists eight arrests cannot
 * turn into eight stalls.
 */
const HITSTOP_GAP = 0.18;

const FIT_M = new Float64Array(9);
const FIT_R = new THREE.Matrix3();
const FIT_S = new THREE.Matrix3();

/**
 * Build the figure: one skinned bark shell, four rigid leather pieces, a skeleton, and every clip.
 *
 * THE SKINNING TRANSFORM, spelled out, because every choice below depends on it.
 *
 * three composes a skinned vertex as
 *
 *     world = meshWorld * bindMatrixInverse * (boneWorld * boneInverse) * bindMatrix * v
 *
 * and, in the default `AttachedBindMode`, it recomputes `bindMatrixInverse = meshWorld^-1` every
 * frame. So `meshWorld` cancels itself out and the whole expression collapses to
 *
 *     world = boneWorld * boneInverse * bindMatrix * v
 *
 * The skin follows the SKELETON's place in the scene graph, not the mesh's. Hence: the normalise
 * scale goes on a group ABOVE THE BONES (`skinRoot`), where it lands in `boneWorld` and is applied
 * once. (Putting it on the SkinnedMesh instead, as the export does, happens to survive — the stale
 * `bindMatrix` captured before the scale is cancelled by the `bindMatrixInverse` three refreshes
 * each frame. `tools/measure-rig.mjs` gate R0 measures the export at 1.0x, not 2x. Relying on that
 * cancellation is still worth avoiding: it makes the scale invisible in the expression that
 * actually drives the skin.)
 *
 * `bind()` IS called with an explicit identity bind matrix, and that one is not cosmetic. Called
 * without one, three runs `skeleton.calculateInverses()`, which discards the GLB's authored
 * `inverseBind` matrices that `buildSkeleton` just passed in and re-derives them from the bones'
 * current rest pose. Those are not the same matrices here: this rig's authored bind pose sits a
 * uniform 4.43e-3 rig units (8.8 mm after the normalise scale) off its node rest pose on every
 * one of the 41 bones, so the export silently skins the figure against a bind pose the GLB does
 * not declare.
  */
export function buildMonsterTreeRig(
  model: EncodedModel,
  stream: string,
  rig: EncodedRig,
  options: RigOptions = {},
): MonsterTreeRig {
  const part = decodeModel(model, stream)[0];
  const skinIndex = decodeUint16s(rig.skinIndex);
  const skinWeight = decodeFloats(rig.skinWeight);
  if (skinIndex.length !== part.position.length / 3 * 4) {
    throw new Error('rig: skin binding does not cover the surface vertex count');
  }

  // White-balance the baked albedo to the reference before anything reads it. The decoder leaves
  // vertex colours in linear space, so the measured per-channel gains apply directly. See
  // ALBEDO_WHITE_BALANCE for the measurement: the mesh's blue channel is a third of what the
  // photograph's bark has, and no light rig can put back a channel the albedo does not carry.
  const [gainR, gainG, gainB] = ALBEDO_WHITE_BALANCE;
  for (let i = 0; i < part.colour.length; i += 3) {
    part.colour[i] = Math.min(1, part.colour[i] * gainR);
    part.colour[i + 1] = Math.min(1, part.colour[i + 1] * gainG);
    part.colour[i + 2] = Math.min(1, part.colour[i + 2] * gainB);
  }

  const triangleCount = part.index.length / 3;
  const costumeMap = options.fuseCostume
    ? new Uint8Array(triangleCount)
    : decodeCostumeMap(COSTUME_RLE, COSTUME_RLE_TRIANGLES);
  if (costumeMap.length !== triangleCount) {
    throw new Error(`rig: costume map covers ${costumeMap.length} triangles, surface has ${triangleCount}`);
  }

  const group = new THREE.Group();
  group.name = 'monster-tree';

  // Bones live under `skinRoot`, which carries the normalise transform. See the note above: this
  // is the group whose world matrix the skin actually follows.
  const skinRoot = new THREE.Group();
  skinRoot.name = 'monster-tree-skin-root';
  skinRoot.position.set(rig.normalise.offset[0], rig.normalise.offset[1], rig.normalise.offset[2]);
  skinRoot.scale.setScalar(rig.normalise.scale);
  group.add(skinRoot);

  const { bones, skeleton, root } = buildSkeleton(rig);
  skinRoot.add(root);
  const boneByName: Record<string, THREE.Bone> = {};
  for (const bone of bones) boneByName[bone.name] = bone;

  const grain = grainDirections(rig, skeleton, skinIndex, skinWeight, part.position.length / 3);
  const shellGeometry = extractTriangles(
    (f) => costumeMap[f] === 0,
    part.index, part.position, part.normal, part.colour, skinIndex, skinWeight, grain,
  ).geometry;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: part.meta.material.roughness,
    metalness: part.meta.material.metalness,
    side: THREE.FrontSide,
  });
  material.name = 'monster-tree-bark';

  const shell = new THREE.SkinnedMesh(shellGeometry, material);
  shell.name = 'bark-shell';
  shell.castShadow = options.castShadow ?? true;
  shell.receiveShadow = options.receiveShadow ?? true;
  group.add(shell);
  shell.bind(skeleton, new THREE.Matrix4());

  // Leather reads darker and glossier than bark in the reference, and it is the one surface on the
  // figure that is not wood, so it gets its own material rather than inheriting the bark's.
  const leather = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.04,
    side: THREE.FrontSide,
  });
  leather.name = 'monster-tree-leather';

  const costume: CostumePiece[] = [];
  // Scratch for the per-frame rigid fit; allocated once, not per frame per piece.
  const fitScratch = new THREE.Vector3();
  const fitWorld = new THREE.Matrix4();
  if (!options.fuseCostume) {
    COSTUME_PIECES.forEach((spec, i) => {
      const code = i + 1;
      const { geometry, kept } = extractTriangles(
        (f) => costumeMap[f] === code,
        part.index, part.position, part.normal, part.colour, null, null, null,
      );
      const mesh = new THREE.Mesh(geometry, leather);
      mesh.name = spec.id;
      mesh.castShadow = options.castShadow ?? true;
      mesh.receiveShadow = options.receiveShadow ?? true;
      mesh.userData.part = { label: spec.label, bone: spec.bone, rigid: true };

      const bone = boneByName[spec.bone];
      if (!bone) throw new Error(`costume ${spec.id}: no bone named ${spec.bone} in this rig`);

      // The piece's vertices are still in bind-pose space. `boneWorld * boneInverse` is exactly
      // the transform a skinned vertex would get from that one bone, so composing it as a single
      // matrix and applying it to every vertex reproduces the skinning WITHOUT the per-vertex
      // blend that shears the leather. `refreshCostume` below composes the blended version of it.
      mesh.matrixAutoUpdate = false;
      const { samples, bones: fitBones } = sampleForFit(kept, part.position, skinIndex, skinWeight);
      const bindCentroid = new THREE.Vector3();
      for (const s of samples) bindCentroid.add(s.bind);
      bindCentroid.multiplyScalar(1 / samples.length);
      const posed = samples.map(() => new THREE.Vector3());
      const deltas = new Map<number, THREE.Matrix4>();
      for (const b of fitBones) deltas.set(b, new THREE.Matrix4());

      mesh.userData.part = {
        label: spec.label,
        rigid: true,
        ridesBone: spec.bone,
        fitSamples: samples.length,
        fitBones: fitBones.map((b) => bones[b].name),
      };

      // Recomposed inside `updateMatrixWorld` rather than in the rig's `update`, so it is correct
      // for ANY driver that walks the scene graph — the renderer, a bare `scene.updateMatrixWorld`,
      // or a gate that seeks the mixer directly and never calls `update` at all. Wiring it into
      // `update` leaves the piece frozen at bind pose for every one of those callers, which reads
      // as a bracer hanging in mid-air while the arm swings away from it.
      //
      // The piece is a child of `group`, added AFTER `skinRoot`, so the bones read here have
      // already been refreshed by the time three walks down to it.
      const baseUpdate = mesh.updateMatrixWorld.bind(mesh);
      mesh.updateMatrixWorld = (force?: boolean) => {
        for (const b of fitBones) deltas.get(b)!.multiplyMatrices(bones[b].matrixWorld, skeleton.boneInverses[b]);
        for (let i = 0; i < samples.length; i += 1) {
          const s = samples[i];
          const q = posed[i].set(0, 0, 0);
          for (let k = 0; k < s.bones.length; k += 1) {
            fitScratch.copy(s.bind).applyMatrix4(deltas.get(s.bones[k])!);
            q.addScaledVector(fitScratch, s.weights[k]);
          }
        }
        rigidFit(samples, posed, bindCentroid, rig.normalise.scale, fitWorld);
        // The fit lands in WORLD space, so undo `group` to reach the piece's parent space and
        // leave the caller free to move the whole figure.
        mesh.matrix.copy(group.matrixWorld).invert().multiply(fitWorld);
        mesh.matrixWorldNeedsUpdate = true;
        baseUpdate(force);
      };

      group.add(mesh);
      costume.push({ id: spec.id, label: spec.label, bone: spec.bone, mesh, triangles: spec.triangles, fitSamples: samples.length });
    });
  }

  const branchStock = extractBranchStock(
    part.index, part.position, part.normal, part.colour, skinIndex, skinWeight,
    rig.bones.map((b) => b.name),
  );

  const sockets: Record<string, THREE.Object3D> = {};
  for (const spec of SOCKETS) {
    const bone = boneByName[spec.bone];
    if (!bone) throw new Error(`socket ${spec.id}: no bone named ${spec.bone} in this rig`);
    const anchor = new THREE.Object3D();
    anchor.name = `socket:${spec.id}`;
    anchor.userData.socket = spec;
    // Same trick as the costume: the measured position is in bind-pose space, so it is carried
    // into bone space by that bone's inverse bind matrix.
    anchor.position
      .set(spec.position[0], spec.position[1], spec.position[2])
      .applyMatrix4(skeleton.boneInverses[bones.indexOf(bone)]);
    bone.add(anchor);
    sockets[spec.id] = anchor;
  }

  /**
   * Recompose every costume piece's virtual bone. Called once per `update`, after the mixer has
   * moved the skeleton and the world matrices have been refreshed.
   *
   * Each contributing bone's skinning delta `boneWorld * boneInverse` is decomposed, the pieces
   * are blended as quaternion + translation + scale (never as raw matrices, which would shear),
   * and the result is expressed relative to `group` so the caller can still transform the whole
   * figure. `nlerp` needs its inputs in the same hemisphere, so each quaternion is sign-aligned to
   * the heaviest one before it is accumulated.
   */
  /**
   * Procedural bone lengthening, applied AFTER the mixer.
   *
   * This is what lets the character do something no shipped clip contains: grow an arm. The rig's
   * 16 clips are a generic biped library — boxing, kicks, dances — and none of them has a branch
   * reaching further than a branch should. Rather than fake it with an effect flying out of the
   * hand, the limb itself extends.
   *
   * Along local +Y, and that is measured, not assumed: every arm bone's child sits on its parent's
   * local +Y at 100% of the segment length (`L_Forearm -> L_Hand` is [0.0000, 0.1245, -0.0000]),
   * so `scale.y` IS length along the limb for this skeleton.
   *
   * Order matters. Every clip here carries scale tracks, so the mixer rewrites `bone.scale` on
   * each update; applying the stretch before it is silently discarded. It multiplies the clip's
   * value rather than replacing it, so whatever the animation was doing survives underneath.
   *
   * The child bone is counter-scaled. Scale propagates down the hierarchy, so lengthening a
   * forearm also stretches the hand hanging off it into a smear; dividing the child by the same
   * factor keeps the fist its own size while the limb behind it grows.
   */
  const stretches = new Map<string, number>();
  const childOf = new Map<string, string>();
  rig.bones.forEach((b) => {
    if (b.parent < 0) return;
    const parent = rig.bones[b.parent].name;
    if (!/Twist/.test(b.name) && !childOf.has(parent)) childOf.set(parent, b.name);
  });

  /**
   * Which child each aimable bone actually points at, and where that child sits at rest.
   *
   * NOT `children[0]`, which is wrong on this rig in two ways that matter. The twist bones are
   * co-located with their parents — `L_ForearmTwist01` sits exactly on `L_Forearm` — so taking the
   * first child gives a zero-length segment with no direction at all; and the child ORDER differs
   * left to right (`L_Thigh` lists L_Calf first, `R_Thigh` lists R_ThighTwist01 first), so the same
   * code would aim the two legs by different bones. Every pair below is named.
   *
   * The twists are not left out — they are children of the bones named here and ride along, which
   * is what matters because they carry most of the arm and leg skin weight.
   */
  const AIM_CHILD: Record<string, string> = {
    Waist: 'Spine01', Spine01: 'Spine02', Spine02: 'NeckTwist01',
    L_Clavicle: 'L_Upperarm', L_Upperarm: 'L_Forearm', L_Forearm: 'L_Hand',
    R_Clavicle: 'R_Upperarm', R_Upperarm: 'R_Forearm', R_Forearm: 'R_Hand',
    L_Thigh: 'L_Calf', L_Calf: 'L_Foot', L_Foot: 'L_ToeBase',
    R_Thigh: 'R_Calf', R_Calf: 'R_Foot', R_Foot: 'R_ToeBase',
  };

  /**
   * Each aimable bone's rest segment direction, expressed in its PARENT's frame.
   *
   * `q_rest * normalize(childLocalPosition)`. Aiming then means finding the swing that takes this
   * to the target and applying it BEFORE the rest rotation, which preserves the bone's authored
   * twist instead of throwing it away — the difference between an arm that points somewhere and an
   * arm that points somewhere with its elbow rotated to a random roll.
   */
  const restAim = new Map<string, { dir: THREE.Vector3; quat: THREE.Quaternion }>();
  for (const [name, childName] of Object.entries(AIM_CHILD)) {
    const bone = boneByName[name];
    const child = boneByName[childName];
    if (!bone || !child) continue;
    const local = child.position.clone();
    if (local.lengthSq() < 1e-12) continue;
    restAim.set(name, {
      dir: local.normalize().applyQuaternion(bone.quaternion).normalize(),
      quat: bone.quaternion.clone(),
    });
  }

  /** Live aims, and scratch for the pose pass. Allocated once, not per bone per frame. */
  const aims = new Map<string, { dir: THREE.Vector3; weight: number }>();
  const worldQ = new Map<string, THREE.Quaternion>();
  const POSE_TARGET = new THREE.Vector3();
  const POSE_LOCAL = new THREE.Vector3();
  const POSE_SWING = new THREE.Quaternion();
  const POSE_AIMED = new THREE.Quaternion();
  const POSE_PARENT_INV = new THREE.Quaternion();
  const POSE_GROUP = new THREE.Quaternion();

  const applyPose = (): void => {
    if (!aims.size) return;
    group.getWorldQuaternion(POSE_GROUP);
    // Seed from the group above the bones, so the walk below is in world space throughout and an
    // aim stays correct while the viewer rotates the figure.
    const seed = worldQ.get('__seed__') ?? new THREE.Quaternion();
    root.parent?.getWorldQuaternion(seed);
    worldQ.set('__seed__', seed);

    const visit = (bone: THREE.Bone, parentWorld: THREE.Quaternion): void => {
      const aim = aims.get(bone.name);
      const rest = restAim.get(bone.name);
      if (aim && rest && aim.weight > 0) {
        POSE_TARGET.copy(aim.dir).applyQuaternion(POSE_GROUP).normalize();
        POSE_PARENT_INV.copy(parentWorld).invert();
        POSE_LOCAL.copy(POSE_TARGET).applyQuaternion(POSE_PARENT_INV).normalize();
        POSE_SWING.setFromUnitVectors(rest.dir, POSE_LOCAL);
        POSE_AIMED.copy(POSE_SWING).multiply(rest.quat);
        if (aim.weight >= 1) bone.quaternion.copy(POSE_AIMED);
        else bone.quaternion.slerp(POSE_AIMED, aim.weight);
      }
      let mine = worldQ.get(bone.name);
      if (!mine) { mine = new THREE.Quaternion(); worldQ.set(bone.name, mine); }
      mine.copy(parentWorld).multiply(bone.quaternion);
      for (const child of bone.children) if ((child as THREE.Bone).isBone) visit(child as THREE.Bone, mine);
    };
    visit(root, seed);
  };

  const relaxClip = (): THREE.AnimationClip | undefined => clips.find((c) => c.name === 'preset:biped:standing_relax');

  const authorClip = (name: string, duration: number, fromSeconds = 3.0): THREE.AnimationClip => {
    const existing = clips.find((c) => c.name === name);
    if (existing) return existing;
    const base = relaxClip();
    const tracks: THREE.KeyframeTrack[] = [];
    if (base) {
      for (const track of base.tracks) {
        const times: number[] = [];
        const values: number[] = [];
        const stride = track.getValueSize();
        for (let i = 0; i < track.times.length; i += 1) {
          const at = track.times[i] - fromSeconds;
          if (at < -0.001 || at > duration + 0.001) continue;
          times.push(Math.max(0, at));
          for (let k = 0; k < stride; k += 1) values.push(track.values[i * stride + k]);
        }
        // A track with one key still holds the pose; a track with none would leave the bone at its
        // bind rotation, which on this rig reads as the figure snapping to a T-pose.
        if (!times.length) {
          times.push(0);
          for (let k = 0; k < stride; k += 1) values.push(track.values[k]);
        }
        const Ctor = track.constructor as new (n: string, t: number[], v: number[]) => THREE.KeyframeTrack;
        tracks.push(new Ctor(track.name, times, values));
      }
    }
    const clip = new THREE.AnimationClip(name, duration, tracks);
    clips.push(clip);
    return clip;
  };

  /**
   * The scale each stretched bone had before this system touched it, captured on the first frame
   * of a stretch and restored when it ends.
   *
   * This exists because of a three.js behaviour that is invisible until it is measured.
   * `PropertyMixer.apply` compares the value it accumulated against the snapshot it took, and
   * writes to the scene graph ONLY if the two differ. Every clip here carries a scale track for
   * all 41 bones, and every one of those tracks is a constant 1 — so the mixer decides nothing has
   * changed and never writes scale at all. A stretch that MULTIPLIES the live value is then never
   * reset, and it compounds: measured on the authored log barrage, `L_Forearm.scale.y` reached
   * **106,195** by the end of a 2.3-second move, throwing the hand hundreds of units out of the
   * world. It survived this long only because the shipped presets happen to vary their scale
   * enough for the mixer to keep writing.
   *
   * Setting from a captured base instead of multiplying the live value cannot compound, whether
   * the mixer writes or not.
   */
  const stretchApplied = new Map<string, { base: number; set: number }>();
  const stretchFactor = new Map<string, number>();
  const stretchDivisor = new Map<string, number>();
  const stretchTouched = new Set<string>();

  /**
   * Apply every stretch, writing each bone exactly ONCE from a value the clip owns.
   *
   * Two things here are not obvious and both were found by measuring rather than reading.
   *
   * 1. NEVER MULTIPLY THE LIVE VALUE. `PropertyMixer.apply` writes to the scene graph only when
   *    the value it accumulated differs from the snapshot it took, and every scale track in this
   *    rig is a constant 1 — so for scale the mixer decides nothing changed and never writes.
   *    A stretch that multiplies what is already there is therefore never reset and compounds:
   *    measured on the authored log barrage, `L_Forearm.scale.y` reached **106,195** inside 2.3
   *    seconds and threw the hand hundreds of units out of the world.
   *
   * 2. A BONE CAN BE BOTH. Waist is stretched and Spine01 is stretched, and Spine01 is also
   *    Waist's child, so it is divided as well as multiplied. Handling those in one pass over the
   *    stretch list wrote Spine01 twice and recorded the second base from the first write's
   *    output — which compounds in the other direction, dragging the spine shorter every frame and
   *    putting a lurch in the shoulders every time the mixer happened to write. So the factors and
   *    the divisors are collected first, and only then is each affected bone written once.
   *
   * The equality test on restore keeps this honest: if the mixer DID write a new value, it will
   * not match what we left there, and we leave it alone.
   */
  const applyStretches = (): void => {
    for (const [name, record] of stretchApplied) {
      const bone = boneByName[name];
      if (bone && Math.abs(bone.scale.y - record.set) < 1e-9) bone.scale.y = record.base;
    }
    stretchApplied.clear();
    stretchFactor.clear();
    stretchDivisor.clear();
    stretchTouched.clear();

    for (const [name, amount] of stretches) {
      if (amount === 0 || !boneByName[name]) continue;
      stretchFactor.set(name, 1 + amount);
      stretchTouched.add(name);
      const child = childOf.get(name);
      if (child && boneByName[child]) {
        stretchDivisor.set(child, (stretchDivisor.get(child) ?? 1) * (1 + amount));
        stretchTouched.add(child);
      }
    }

    for (const name of stretchTouched) {
      const bone = boneByName[name];
      if (!bone) continue;
      const base = bone.scale.y;
      const value = base * (stretchFactor.get(name) ?? 1) / (stretchDivisor.get(name) ?? 1);
      bone.scale.y = value;
      stretchApplied.set(name, { base, set: value });
    }
  };

  // Hitstop state. The remaining hold, its full length, how slowly the clip runs at the deepest
  // point of it, and how long since the last one ended.
  let stopFor = 0;
  let stopSpan = 1;
  let stopScale = 1;
  let sinceStop = 99;
  let lastWeight = 0;

  const mixer = new THREE.AnimationMixer(shell);
  const clips = buildClips(rig);
  if (options.inPlace !== false) holdRootMotion(clips, 'Hip');
  let action: THREE.AnimationAction | null = null;
  let currentName: string | null = null;

  const play = (which: string | number, fadeSeconds = 0.3): boolean => {
    const clip = typeof which === 'number' ? clips[which] : clips.find((c) => c.name === which);
    if (!clip) return false;
    const next = mixer.clipAction(clip);
    if (next === action) {
      // RESTART, do not no-op. Three pairs of skills share a clip — Deep Root Surge and Splinter
      // Combo are both box_02, Impaling Bough and Bark Strike are both box_01, Grove Awakening and
      // Wildfire Sap are both `fire` — and returning early left the action running from wherever
      // the previous move had reached. The incoming skill then cleared its fired set and started
      // firing cues against a playhead already past half of them, so choosing Deep Root Surge
      // straight after Splinter Combo began the move from its own middle with its windup skipped.
      next.reset();
      next.play();
      return true;
    }
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.reset();
    next.setEffectiveWeight(1);
    if (action && fadeSeconds > 0) {
      // Cross-fade rather than cut. Two clips that both start from the rest pose still disagree on
      // every bone at their own frame 0, so a hard switch pops on the first frame.
      next.crossFadeFrom(action, fadeSeconds, true).play();
    } else {
      action?.stop();
      next.play();
    }
    action = next;
    currentName = clip.name;
    return true;
  };

  /**
   * Echoes share `clips` deliberately. An AnimationClip is immutable keyframe data and every
   * mixer builds its own actions and interpolants over it, so five echoes cost five sets of
   * actions rather than five copies of 9.4 MB of keyframes — and, more usefully, they inherit the
   * root-motion hold that `holdRootMotion` already applied in place. Rebuilding the clips per echo
   * would silently give the copies their original root motion back and send them walking out from
   * under their own ghosts.
   */
  const makeEcho = (material: THREE.Material): RigEcho => {
    const object = new THREE.Group();
    object.name = 'monster-tree-echo';

    const echoSkinRoot = new THREE.Group();
    echoSkinRoot.position.copy(skinRoot.position);
    echoSkinRoot.scale.copy(skinRoot.scale);
    object.add(echoSkinRoot);

    const built = buildSkeleton(rig);
    echoSkinRoot.add(built.root);

    const mesh = new THREE.SkinnedMesh(shellGeometry, material);
    mesh.name = 'monster-tree-echo-shell';
    // A ghost is not a body: it neither casts nor receives. Shadows from five overlapping copies
    // put five hard silhouettes on the floor around a figure that has one, which is the single
    // fastest way to make copies read as five separate props instead of as one thing repeating.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    object.add(mesh);
    mesh.bind(built.skeleton, new THREE.Matrix4());

    const echoMixer = new THREE.AnimationMixer(mesh);
    let echoAction: THREE.AnimationAction | null = null;
    let echoClip: string | null = null;

    return {
      object,
      mesh,
      seek: (which: string, seconds: number) => {
        if (which !== echoClip) {
          const clip = clips.find((c) => c.name === which);
          if (!clip) return;
          echoAction?.stop();
          echoAction = echoMixer.clipAction(clip);
          echoAction.setLoop(THREE.LoopRepeat, Infinity);
          echoAction.reset();
          echoAction.play();
          echoClip = which;
        }
        if (!echoAction) return;
        // Seek rather than integrate. An echo trailing the original by a fixed lag has to land on
        // an exact clip time every frame; advancing it by its own delta lets the two drift apart
        // over a long move, and the lag is the only thing that makes an afterimage read as one.
        echoAction.time = Math.max(0, seconds % echoAction.getClip().duration);
        echoMixer.update(0);
      },
      dispose: () => {
        echoMixer.stopAllAction();
        built.skeleton.dispose();
      },
    };
  };

  const rigged: MonsterTreeRig = {
    group,
    shell,
    costume,
    skeleton,
    bones: boneByName,
    sockets,
    branchStock,
    mixer,
    clips,
    play,
    current: () => currentName,
    // NOTE: this does NOT apply the stretches. `applyStretch` does, and it has to be called
    // separately, after whatever decides them for this frame. Doing both here and there multiplies
    // the factor twice — the limb reached nearly five times its length instead of twice.
    update: (deltaSeconds: number) => {
      let step = deltaSeconds;
      if (stopFor > 0) {
        // Scale only the part of this frame that falls inside the hold, so a long frame that
        // straddles the end of it does not swallow the rest of the hold whole.
        const held = Math.min(stopFor, deltaSeconds);
        // EASE OUT of the hold instead of releasing it on one frame. A hold that ends abruptly
        // takes the body from near-frozen to full speed between two frames, and that step is a
        // larger discontinuity than the hold was ever worth — it is felt as a hitch in the
        // animation rather than as weight in the blow. Measured on box_02 at scale 0.06: the
        // release frame jumped the clip 16x its neighbours' step. Ramping the scale back over the
        // tail of the hold keeps the largest frame-to-frame ratio under 2.
        const through = 1 - Math.max(0, stopFor - held * 0.5) / stopSpan;
        const scale = stopScale + (1 - stopScale) * through ** 0.55;
        step = held * scale + (deltaSeconds - held);
        stopFor -= held;
        if (stopFor <= 0) sinceStop = 0;
      } else {
        sinceStop += deltaSeconds;
      }
      mixer.update(step);
    },
    hitstop: (seconds: number, scale = 0.08) => {
      if (seconds <= 0) return;
      // REFRACTORY GAP. Holds landing closer together than this stop reading as impacts and start
      // reading as a dropped frame rate, because there is no run of normal-speed motion between
      // them to be interrupted. Splinter Combo measured eight holds inside 2.267s — 17% of the
      // clip frozen across eight separate stalls — and the move looked broken rather than heavy.
      // A hold inside the gap is admitted only if it is genuinely stronger than the one just
      // played, so a real payoff can still cut through a flurry.
      const weight = seconds * (1 - scale);
      if (stopFor <= 0 && sinceStop < HITSTOP_GAP && weight < lastWeight * 1.5) return;
      // The strongest hold wins rather than the latest, so a light hit landing inside a heavy
      // one's hold cannot shorten it.
      if (weight >= stopFor * (1 - stopScale)) {
        stopFor = seconds;
        stopSpan = seconds;
        stopScale = scale;
        lastWeight = weight;
      }
    },
    makeEcho,
    aim: (bone: string, direction: THREE.Vector3 | null, weight = 1) => {
      if (!direction || weight <= 0) { aims.delete(bone); return; }
      const held = aims.get(bone);
      if (held) { held.dir.copy(direction).normalize(); held.weight = weight; }
      else aims.set(bone, { dir: direction.clone().normalize(), weight });
    },
    applyPose,
    authorClip,
    applyStretch: () => applyStretches(),
    stretch: (bone: string, amount: number) => {
      if (amount === 0) stretches.delete(bone);
      else stretches.set(bone, amount);
    },
    dispose: () => {
      mixer.stopAllAction();
      shell.geometry.dispose();
      material.dispose();
      leather.dispose();
      for (const piece of costume) piece.mesh.geometry.dispose();
      skeleton.dispose();
    },
  };

  group.userData.rig = rigged;
  // The static-model contract passes ELAPSED seconds; a mixer needs a delta. Keeping the elapsed
  // signature and differencing it here means the README's `update(model, clock.getElapsedTime())`
  // advances the animation instead of silently freezing it on frame 0.
  let lastElapsed: number | null = null;
  group.userData.update = (elapsed: number) => {
    const step = lastElapsed === null ? 0 : Math.max(0, elapsed - lastElapsed);
    lastElapsed = elapsed;
    rigged.update(step);
  };

  return rigged;
}
