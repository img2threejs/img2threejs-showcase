import * as THREE from 'three';
import {
  buildSkeleton,
  buildClips,
  decodeModel,
  type DecodedPart,
  type EncodedModel,
  type EncodedRig,
} from './meshCodec';
import { splitByRegion, copySkinAttributes, createRegionMaterial } from './regionSplit';
import { REGIONS, COSTUME_REGIONS, type RegionId } from './characterPalette';
import { measureSockets, attachSockets, type MeasuredSocket } from './sockets';
import { neutraliseRootMotion, type RootMotion } from './rigFix';

/**
 * The animated character: one skeleton, five skinned meshes, sockets on real bones.
 *
 * WHAT CHANGED FROM THE EXPORT'S `createTqRigged`, and why:
 *
 * 1. The costume is its own geometry. The export produced ONE merged shell, so the armour could not
 *    be addressed, lit or torn separately from the body inside it. `splitByRegion` partitions that
 *    shell into crimson lacquer, indigo cloth, gold filigree, skin and hair — a partition, never a
 *    decimation, so every vertex keeps its own joint indices and weights and the pieces deform
 *    exactly as they did while merged.
 *
 * 2. All five meshes share ONE `THREE.Skeleton` instance. Not five copies driven in parallel — one
 *    object, five readers. A costume mesh physically cannot drift out of step with the body when
 *    both are reading the same bone matrices.
 *
 * 3. The clips are root-motion corrected. See `rigFix.ts` for the measurement: locomotion was baked
 *    onto `Hip`, so the figure translated up to 7.6 units away from a stationary `Root` and dragged
 *    off the stage. The horizontal drift is removed and handed back as `RootMotion`.
 *
 * BIND ORDER IS LOAD-BEARING. The export bound the skeleton while everything was still unscaled
 * and unparented, then applied the 1.9 normalisation afterwards; measured at the rest pose that
 * reproduces the bind geometry to 3.2e-8 and renders a 1.896-unit figure. `three` recomputes the
 * inverse bind matrices inside `bind()` when no explicit bind matrix is passed, so the ORDER of bind
 * against scale decides the result. This factory reproduces that order deliberately, and
 * `tools/splitGate.ts` re-measures the outcome rather than assuming the reproduction worked.
 */

export interface TqCharacter {
  /** Root group — position/rotate this to place the character. */
  group: THREE.Group;
  /** Container holding the five skinned meshes; the bone root lives under the first of them. */
  figure: THREE.Group;
  /** One skinned mesh per region, keyed by region id. */
  meshes: Map<RegionId, THREE.SkinnedMesh>;
  /** The single skeleton every mesh reads. */
  skeleton: THREE.Skeleton;
  bones: THREE.Bone[];
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  /** Socket nodes parented to real bones, keyed by socket id. */
  sockets: Map<string, THREE.Object3D>;
  measuredSockets: MeasuredSocket[];
  /** Travel removed from each clip, so a locomotion controller can still use it. */
  rootMotion: RootMotion[];
  /** Height of the figure in world units, measured after assembly. */
  height: number;
  play(clip: string | number, fadeSeconds?: number): boolean;
  /** Current clip name, or null before the first play. */
  current(): string | null;
  update(deltaSeconds: number): void;
  /** Show or hide the costume without touching the body underneath. */
  setCostumeVisible(visible: boolean): void;
}

export interface TqCharacterOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Keep the baked travel instead of removing it. Default false — see `rigFix.ts`. */
  keepRootMotion?: boolean;
}

/**
 * The surfaces and the rig, fetched and decoded once.
 *
 * Both are imported DYNAMICALLY rather than at the top of this file, and that is a bundling
 * decision, not a style one: the embedded rig and surface stream are about 19 MB of source between
 * them, and a static import folds them into the gallery's shared entry chunk, so every visitor
 * downloads this character to look at any demo. Behind `import()` they become their own chunk that
 * only this demo's page fetches — the same split the other data-heavy demos here use.
 *
 * Decoding 159,184 quantised vertices out of base64 is the part felt as a frozen page; building
 * `three` objects from the result is not. Doing it here keeps `createTqCharacter` cheap and
 * synchronous, which the registry's `build` contract requires.
 */
interface TqSource {
  rig: EncodedRig;
  part: DecodedPart;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

let decodedSource: TqSource | null = null;
let pending: Promise<void> | null = null;

/**
 * Fetch and decode the embedded data. Safe to await any number of times — the work happens once and
 * every later call resolves against the same promise.
 */
export function prepareTqCharacter(): Promise<void> {
  if (decodedSource) return Promise.resolve();
  pending ??= (async (): Promise<void> => {
    const [{ RIG }, { SURFACE_MODEL, SURFACE_STREAM }] = await Promise.all([
      import('./rigData'),
      import('./surfaceData.high'),
    ]);
    // Yield once between arrival and decode so the browser can paint the loader.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const part = decodeModel(SURFACE_MODEL as EncodedModel, SURFACE_STREAM)[0];
    decodedSource = {
      rig: RIG,
      part,
      skinIndex: decodeBase64Uint16(RIG.skinIndex),
      skinWeight: decodeBase64Float32(RIG.skinWeight),
    };
  })();
  return pending;
}

/** Whether `createTqCharacter` can run right now. */
export function isTqCharacterReady(): boolean {
  return decodedSource !== null;
}

export function createTqCharacter(options: TqCharacterOptions = {}): TqCharacter {
  if (!decodedSource) {
    throw new Error('await prepareTqCharacter() before createTqCharacter() — the rig and surfaces load on demand');
  }
  const { rig, part, skinIndex, skinWeight } = decodedSource;

  if (skinIndex.length / 4 !== part.position.length / 3) {
    throw new Error(
      `rig payload covers ${String(skinIndex.length / 4)} vertices but the shell has ${String(part.position.length / 3)}`,
    );
  }

  const regions = splitByRegion(part);
  for (const region of regions) copySkinAttributes(region, skinIndex, skinWeight);

  const { bones, skeleton, root } = buildSkeleton(rig);

  const meshes = new Map<RegionId, THREE.SkinnedMesh>();
  for (const region of regions) {
    const mesh = new THREE.SkinnedMesh(region.geometry, createRegionMaterial(region.id));
    mesh.name = `tq:${region.id}`;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.region = REGIONS[region.id];
    mesh.userData.triangles = region.triangles;
    meshes.set(region.id, mesh);
  }

  // --- bind in the export's exact order, because the order is what makes the bind correct ---
  //
  // `three`'s `bind()` recomputes the inverse bind matrices from the bones' CURRENT world matrices
  // whenever no explicit bind matrix is passed. So the bones must already be parented under the
  // mesh and sitting at their unscaled rest pose at the moment of the call. Binding first and
  // parenting afterwards — the arrangement that reads more naturally — leaves the bones with stale
  // world matrices and inverts against the identity instead: measured, that put the rest-pose
  // binding error at 8.6e-1 world units instead of 3.2e-8. The gate caught it; this order fixes it.
  //
  // The carrier is the mesh that owns the bone root, mirroring `buildRiggedModel`. The normalisation
  // scale then goes on EVERY mesh, so each one's model matrix matches the carrier's and all five
  // read the same bone matrices out of the one shared skeleton.
  const ordered = [...meshes.values()];
  const carrier = ordered[0];
  carrier.add(root);
  for (const mesh of ordered) mesh.bind(skeleton);

  const figure = new THREE.Group();
  figure.name = 'tq:figure';
  for (const mesh of ordered) figure.add(mesh);

  const group = new THREE.Group();
  group.name = 'tq';
  group.add(figure);
  for (const mesh of ordered) mesh.scale.setScalar(rig.normalise.scale);
  group.position.set(rig.normalise.offset[0], rig.normalise.offset[1], rig.normalise.offset[2]);
  group.updateMatrixWorld(true);

  // --- sockets, measured from the shell and parented to real bones ---
  const measuredSockets = measureSockets(part, rig, skinIndex, skinWeight);
  const sockets = attachSockets(bones, measuredSockets);

  // --- clips ---
  const rawClips = buildClips(rig);
  const fixed = options.keepRootMotion
    ? { clips: rawClips, motion: [] as RootMotion[] }
    : neutraliseRootMotion(rawClips, rig);
  const clips = fixed.clips;

  // The mixer drives the BONE ROOT, not any one mesh: the tracks address bones by name, and no
  // single mesh owns the skeleton any more.
  const mixer = new THREE.AnimationMixer(root);
  let currentAction: THREE.AnimationAction | null = null;
  let currentName: string | null = null;

  const play = (which: string | number, fadeSeconds = 0.3): boolean => {
    const clip = typeof which === 'number' ? clips[which] : clips.find((c) => c.name === which);
    if (!clip) return false;
    const next = mixer.clipAction(clip);
    if (next === currentAction) return true;
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.reset();
    if (currentAction && fadeSeconds > 0) {
      // Cross-fade, never cut: two looping clips at different phases pop hard on the first frame.
      next.crossFadeFrom(currentAction, fadeSeconds, false).play();
    } else {
      currentAction?.stop();
      next.play();
    }
    currentAction = next;
    currentName = clip.name;
    return true;
  };

  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const mesh of meshes.values()) {
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  }
  const height = bounds.getSize(new THREE.Vector3()).y;

  return {
    group,
    figure,
    meshes,
    skeleton,
    bones,
    mixer,
    clips,
    sockets,
    measuredSockets,
    rootMotion: fixed.motion,
    height,
    play,
    current: () => currentName,
    // The mixer takes a DELTA. Passing elapsed time makes every clip accelerate without bound.
    update: (deltaSeconds: number) => mixer.update(deltaSeconds),
    setCostumeVisible: (visible: boolean) => {
      for (const id of COSTUME_REGIONS) {
        const mesh = meshes.get(id);
        if (mesh) mesh.visible = visible;
      }
    },
  };
}

function decodeBase64Uint16(text: string): Uint16Array {
  const bytes = base64Bytes(text);
  const out = new Uint16Array(bytes.length / 2);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

function decodeBase64Float32(text: string): Float32Array {
  const bytes = base64Bytes(text);
  const out = new Float32Array(bytes.length / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

/** Works in the browser and under node, so the probes and the viewer share one decode path. */
function base64Bytes(text: string): Uint8Array {
  if (typeof atob === 'function') {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  const buffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (!buffer) throw new Error('no base64 decoder available');
  return buffer.from(text, 'base64');
}

/** Region ids present in the split, with their measured triangle counts. */
export function describeRegions(character: TqCharacter): { id: RegionId; label: string; triangles: number; vertices: number }[] {
  return [...character.meshes.entries()].map(([id, mesh]) => ({
    id,
    label: REGIONS[id].label,
    triangles: mesh.userData.triangles as number,
    vertices: (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count,
  }));
}
