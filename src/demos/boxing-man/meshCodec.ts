import * as THREE from 'three';

/**
 * Measured-surface codec: rebuild a model's parts from the encoded stream that ships inside the
 * generated module, then assemble them into a plain Three.js group with named, pivoted parts.
 *
 * This file is copied verbatim into every download, so it depends on nothing but `three`. The
 * factory that accompanies it holds the model-specific constants; this holds the format.
 *
 * Stream layout, per part, in order:
 *
 *   positions   3 x uint16 LE per vertex, quantised over the model's own bounding box. The box is
 *               recorded in `quantization`, so a 2 m figure resolves to ~0.03 mm — finer than the
 *               triangle mesh it came from.
 *   normals     one 16-bit octahedral-encoded normal per vertex (~1 degree). Kept rather than
 *               recomputed so hard edges the source authored survive.
 *   colours     8 bits per channel, sRGB, exactly as sampled from the source's own albedo at each
 *               vertex. Converted to linear when the geometry is built.
 *   indices     varint zigzag deltas, three per triangle.
 *
 * Every section's size is recorded per part and checked as it is consumed, so a mis-read in one
 * part fails loudly there instead of shifting every part after it.
 */

export type Vec3 = [number, number, number];

/** Levels of detail, cheapest first. `high` is the measurement; the others are decimated from it. */
export const QUALITY_LEVELS = ['low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITY_LEVELS)[number];

/**
 * Pick a level for the machine that is asking.
 *
 * `?quality=` wins outright — a reviewer comparing levels must be able to force one. Otherwise a
 * device that reports few cores or little memory, or that has no fine pointer (a phone), gets the
 * cheap level: the whole reason the levels exist is that the expensive one should never be
 * downloaded onto a phone at all.
 */
export function preferredQuality(fallback: Quality = 'high'): Quality {
  if (typeof window === 'undefined') return fallback;
  const asked = (new URLSearchParams(window.location.search).get('quality') ?? '').toLowerCase();
  if ((QUALITY_LEVELS as readonly string[]).includes(asked)) return asked as Quality;

  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
  const weak = (nav.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4;
  if (coarse && smallScreen) return 'low';
  if (coarse || weak) return 'medium';
  return fallback;
}

export interface PartMaterial {
  /** Factor the sampled vertex colours were already multiplied by; recorded for provenance. */
  baseColorFactor: [number, number, number, number];
  metalness: number;
  roughness: number;
  emissive: string;
  doubleSided: boolean;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  opacity: number;
  /** Which source channels were texture-driven, so the scalars above are read as medians, not authored constants. */
  textured: { baseColor: boolean; metallicRoughness: boolean; normal: boolean; emissive: boolean };
}

export interface EncodedPart {
  id: string;
  label: string;
  /** Measured-bounds hypothesis of what this part is; never confirmed by the pipeline itself. */
  hypothesis: string;
  confidence: number;
  vertexCount: number;
  triangleCount: number;
  bounds: { min: Vec3; max: Vec3 };
  material: PartMaterial;
  bytes: { positions: number; normals: number; colours: number; indices: number };
  sourceNode: { index: number; name: string | null };
}

export interface EncodedModel {
  version: 1;
  quantization: { origin: Vec3; extent: Vec3 };
  /** Height of the figure in model units after normalisation (feet at y = 0). */
  height: number;
  parts: EncodedPart[];
}

export interface DecodedPart {
  meta: EncodedPart;
  position: Float32Array;
  normal: Float32Array;
  /** Linear RGB, 0..1. */
  colour: Float32Array;
  index: Uint32Array;
}

export interface BuildOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Built-in idle motion applied through `group.userData.update(elapsedSeconds)`. */
  animation?: 'none' | 'turntable' | 'breathe' | 'hover';
  /** Override material scalars per part id, e.g. to correct a median that read wrong. */
  materialOverrides?: Record<string, Partial<Pick<PartMaterial, 'metalness' | 'roughness'>>>;
}

function decodeBase64(text: string): Uint8Array {
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

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse of the octahedral packing in the encoder. */
function decodeOctNormal(packed: number, out: Float32Array, at: number): void {
  let x = ((packed & 0xff) / 255) * 2 - 1;
  let y = ((packed >> 8) / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const len = Math.hypot(x, y, z) || 1;
  out[at] = x / len;
  out[at + 1] = y / len;
  out[at + 2] = z / len;
}

/**
 * Decode the stream one part at a time.
 *
 * The stream is a single sequential cursor, so a generator is its natural shape: a caller that
 * wants everything drains it, and a caller that wants to draw the model as it appears takes one
 * part per frame. `decodeModel` below is the drain-it-all case.
 */
export function* decodeParts(model: EncodedModel, base64: string): Generator<DecodedPart, void, void> {
  if (model.version !== 1) throw new Error(`unsupported surface stream version ${String(model.version)}`);
  const stream = decodeBase64(base64);
  const { origin, extent } = model.quantization;
  let at = 0;

  const readVarint = (): number => {
    let value = 0;
    let shift = 1;
    for (;;) {
      if (at >= stream.length) throw new Error('surface stream: truncated varint');
      const byte = stream[at];
      at += 1;
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  };

  const decodeOne = (meta: EncodedPart): DecodedPart => {
    const n = meta.vertexCount;
    const t = meta.triangleCount;
    if (meta.bytes.positions !== n * 6 || meta.bytes.normals !== n * 2 || meta.bytes.colours !== n * 3) {
      throw new Error(`part ${meta.id}: section sizes disagree with the vertex count`);
    }

    const position = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) {
      const q = stream[at] | (stream[at + 1] << 8);
      at += 2;
      const axis = i % 3;
      position[i] = origin[axis] + (q / 65535) * extent[axis];
    }

    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const packed = stream[at] | (stream[at + 1] << 8);
      at += 2;
      decodeOctNormal(packed, normal, i * 3);
    }

    const colour = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) {
      colour[i] = srgbToLinear(stream[at] / 255);
      at += 1;
    }

    const indicesAt = at;
    const index = new Uint32Array(t * 3);
    let previous = 0;
    for (let i = 0; i < t * 3; i += 1) {
      const raw = readVarint();
      previous += raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
      if (previous < 0 || previous >= n) {
        throw new Error(`part ${meta.id}: index ${previous} out of range for ${n} vertices`);
      }
      index[i] = previous;
    }
    if (at - indicesAt !== meta.bytes.indices) {
      throw new Error(`part ${meta.id}: index section ${at - indicesAt} bytes, expected ${meta.bytes.indices}`);
    }
    return { meta, position, normal, colour, index };
  };

  for (const meta of model.parts) yield decodeOne(meta);

  // Checked only after the last part: a short read in the middle already fails on its own section
  // size, and this catches trailing bytes nothing claimed.
  if (at !== stream.length) {
    throw new Error(`surface stream: consumed ${at} of ${stream.length} bytes`);
  }
}

/** Decode every part at once. */
export function decodeModel(model: EncodedModel, base64: string): DecodedPart[] {
  return [...decodeParts(model, base64)];
}

function makeMaterial(part: EncodedPart, overrides?: Partial<Pick<PartMaterial, 'metalness' | 'roughness'>>): THREE.MeshStandardMaterial {
  const m = part.material;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: overrides?.metalness ?? m.metalness,
    roughness: overrides?.roughness ?? m.roughness,
    emissive: new THREE.Color(m.emissive),
    side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: m.alphaMode === 'BLEND' || m.opacity < 1,
    opacity: m.opacity,
    alphaTest: m.alphaMode === 'MASK' ? m.alphaCutoff : 0,
  });
  material.name = `${part.id}-material`;
  return material;
}

/**
 * Assemble the decoded parts into a group. Each part is a named mesh inside an unnamed pivot group
 * positioned at the part's own centre, so `group.userData.pivots[id].rotation` moves that part
 * about itself without rebuilding geometry — the same anchor contract img2threejs specs promise.
 */
/** Turn one decoded part into its pivot group. Shared by the one-shot and progressive builders. */
function addPart(group: THREE.Group, part: DecodedPart, options: BuildOptions): void {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(part.colour, 3));
  const index = part.position.length / 3 <= 65535 ? new Uint16Array(part.index) : part.index;
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const { min, max } = part.meta.bounds;
  const centre = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);

  const mesh = new THREE.Mesh(geometry, makeMaterial(part.meta, options.materialOverrides?.[part.meta.id]));
  mesh.name = part.meta.id;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.position.copy(centre).negate();
  mesh.userData.part = {
    label: part.meta.label,
    hypothesis: part.meta.hypothesis,
    confidence: part.meta.confidence,
    triangles: part.meta.triangleCount,
  };

  const pivot = new THREE.Group();
  pivot.position.copy(centre);
  pivot.add(mesh);
  group.add(pivot);
  (group.userData.pivots as Record<string, THREE.Group>)[part.meta.id] = pivot;
  if (part.meta.confidence < 0.7) {
    (group.userData.sculptRuntime as { inferred: string[] }).inferred.push(
      `${part.meta.id}: ${part.meta.hypothesis} (${part.meta.confidence.toFixed(2)})`,
    );
  }
}

/** The empty group, with every contract attached, ready for parts to land in. */
function makeShell(model: EncodedModel, options: BuildOptions): THREE.Group {
  const group = new THREE.Group();
  group.userData.pivots = {} as Record<string, THREE.Group>;
  group.userData.height = model.height;
  // Read by the showcase viewer's provenance panel: this is a measured surface rebuilt from a
  // generated GLB, not hand-sculpted primitives, and the part names are hypotheses.
  group.userData.sculptRuntime = {
    route: 'playground: provider measurement -> embedded measured surfaces',
    exactnessTier: 'measured-surface',
    inferred: [] as string[],
  };

  const animation = options.animation ?? 'turntable';
  const baseY = group.position.y;
  const update = (elapsed: number): void => {
    if (animation === 'turntable') group.rotation.y = elapsed * 0.35;
    else if (animation === 'hover') group.position.y = baseY + Math.sin(elapsed * 1.4) * model.height * 0.02;
    else if (animation === 'breathe') {
      const s = 1 + Math.sin(elapsed * 1.8) * 0.012;
      group.scale.set(s, s, s);
    }
  };
  group.userData.update = update;
  // The showcase viewer collects `userData.tick(dt, elapsed)` from every object it renders, so a
  // registry entry needs no wiring of its own to animate.
  if (animation !== 'none') group.userData.tick = (_dt: number, elapsed: number): void => update(elapsed);
  return group;
}

/**
 * Build the whole model in one call. Simple, and it blocks the main thread for as long as the
 * decode takes — fine for a small model, felt as a freeze on a large one. See
 * `buildModelProgressive` when the page has to stay responsive.
 */
export function buildModel(model: EncodedModel, base64: string, options: BuildOptions = {}): THREE.Group {
  const group = makeShell(model, options);
  for (const part of decodeParts(model, base64)) addPart(group, part, options);
  return group;
}

export interface ProgressiveOptions extends BuildOptions {
  /** Called after each part lands, with how many exist so far. */
  onPart?: (added: number, total: number, group: THREE.Group) => void;
  /** Milliseconds of decoding to do per frame before yielding. Default 8, about half a frame. */
  budgetMs?: number;
}

/**
 * Build across frames instead of in one block.
 *
 * Returns the group IMMEDIATELY — empty, already in the scene if you add it — and fills it part by
 * part, handing the frame back to the browser between batches. The model appears as it is decoded
 * rather than after a pause in which nothing renders, and input keeps working throughout.
 *
 * The geometry is identical to `buildModel`'s; only the timing differs.
 *
 * ONE STEP IS STILL NOT SPLIT: turning the base64 stream into bytes happens once, before the first
 * part can be read, because every part indexes into that one buffer. Measured at about 5 ms for a
 * 1 MB stream and 96 ms for a 29 MB one, so it is only noticeable on the largest models.
 */
export function buildModelProgressive(
  model: EncodedModel,
  base64: string,
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  const group = makeShell(model, options);
  const total = model.parts.length;
  const budget = options.budgetMs ?? 8;
  const parts = decodeParts(model, base64);
  let added = 0;

  const done = new Promise<THREE.Group>((resolve, reject) => {
    const step = (): void => {
      const until = now() + budget;
      try {
        do {
          const next = parts.next();
          if (next.done) {
            resolve(group);
            return;
          }
          addPart(group, next.value, options);
          added += 1;
          options.onPart?.(added, total, group);
          // At least one part per frame, however tight the budget: a part that takes longer than
          // the whole budget would otherwise never make progress.
        } while (now() < until);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      schedule(step);
    };
    schedule(step);
  });

  return { group, done };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function schedule(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
}

/** A neutral three-point studio rig scaled to the figure, for downloads that have no look-dev yet. */
export function createStudioLights(height: number): THREE.Group {
  const rig = new THREE.Group();
  rig.name = 'studio-lights';
  const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
  key.position.set(height * 1.6, height * 2.2, height * 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.05;
  key.shadow.camera.far = height * 8;
  const span = height * 1.4;
  key.shadow.camera.left = -span;
  key.shadow.camera.right = span;
  key.shadow.camera.top = span;
  key.shadow.camera.bottom = -span;
  key.shadow.bias = -0.0004;
  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.9);
  fill.position.set(-height * 2, height * 1.1, height * 0.8);
  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(-height * 0.6, height * 1.8, -height * 2.2);
  const ambient = new THREE.HemisphereLight(0xdfe6f2, 0x2a2622, 0.5);
  rig.add(key, fill, rim, ambient);
  return rig;
}

// ------------------------------------------------------------------ skeleton and clips

/**
 * A rigged model is shipped as CODE the same way a static one is: the skeleton, the per-vertex
 * joint weights and every clip's keyframes are embedded here, and nothing is fetched at runtime.
 *
 * The geometry stays in bind space — the space the inverse bind matrices are expressed in — so the
 * normalisation that puts the figure feet-at-zero is a transform on the group, never an edit to
 * the vertices. Editing them would move the mesh out from under its own skeleton.
 */
export interface EncodedBone {
  name: string;
  /** Index into `bones`, or -1 for a root. Parents always come first. */
  parent: number;
  position: Vec3;
  quaternion: [number, number, number, number];
  scale: Vec3;
  /** Column-major 4x4 inverse bind matrix. */
  inverseBind: number[];
}

export interface EncodedClipTrack {
  bone: number;
  /** base64 Float32 keyframe times, seconds. */
  times: string;
  /** base64 Float32 values; present only for the properties this clip animates. */
  position?: string;
  quaternion?: string;
  scale?: string;
}

export interface EncodedClip {
  name: string;
  duration: number;
  tracks: EncodedClipTrack[];
}

export interface EncodedRig {
  bones: EncodedBone[];
  clips: EncodedClip[];
  /** base64 Uint16, 4 joint indices per vertex. */
  skinIndex: string;
  /** base64 Float32, 4 weights per vertex, already normalised to sum 1. */
  skinWeight: string;
  /** Applied to the group so the figure stands at the origin without touching bind space. */
  normalise: { scale: number; offset: Vec3 };
  vertexCount: number;
}

function decodeFloats(text: string): Float32Array {
  const bytes = decodeBase64(text);
  // A base64 payload has no alignment guarantee, so copy rather than view the decoded buffer.
  const out = new Float32Array(bytes.length / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

function decodeUint16s(text: string): Uint16Array {
  const bytes = decodeBase64(text);
  const out = new Uint16Array(bytes.length / 2);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

/** Rebuild the skeleton, in the same parents-first order it was written in. */
export function buildSkeleton(rig: EncodedRig): { bones: THREE.Bone[]; skeleton: THREE.Skeleton; root: THREE.Bone } {
  const bones = rig.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.set(b.position[0], b.position[1], b.position[2]);
    bone.quaternion.set(b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]);
    bone.scale.set(b.scale[0], b.scale[1], b.scale[2]);
    return bone;
  });
  let root: THREE.Bone | null = null;
  rig.bones.forEach((b, i) => {
    if (b.parent >= 0) bones[b.parent].add(bones[i]);
    else if (!root) root = bones[i];
  });
  const inverses = rig.bones.map((b) => new THREE.Matrix4().fromArray(b.inverseBind));
  const skeleton = new THREE.Skeleton(bones, inverses);
  return { bones, skeleton, root: root ?? bones[0] };
}

/** Turn the embedded keyframes back into clips an AnimationMixer can play. */
export function buildClips(rig: EncodedRig): THREE.AnimationClip[] {
  return rig.clips.map((clip) => {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const name = rig.bones[track.bone]?.name;
      if (!name) continue;
      const times = decodeFloats(track.times);
      if (track.position) tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times as unknown as number[], decodeFloats(track.position) as unknown as number[]));
      if (track.quaternion) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times as unknown as number[], decodeFloats(track.quaternion) as unknown as number[]));
      if (track.scale) tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times as unknown as number[], decodeFloats(track.scale) as unknown as number[]));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
}

export interface RiggedModel {
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  /** Cross-fade to a clip by name or index; returns false if there is no such clip. */
  play(clip: string | number, fadeSeconds?: number): boolean;
  /** Advance the animation. Call it with the frame delta in seconds. */
  update(deltaSeconds: number): void;
}

/**
 * Build the skinned model. The single part a rig produces is deliberate: rigging merges the mesh,
 * so an animated model has one shell rather than the named parts a segmented static model has.
 */
export function buildRiggedModel(
  model: EncodedModel,
  base64: string,
  rig: EncodedRig,
  options: BuildOptions = {},
): RiggedModel {
  const decoded = decodeModel(model, base64);
  const group = new THREE.Group();
  group.name = `${model.parts[0]?.id ?? 'model'}-rigged`;

  const part = decoded[0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(part.colour, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(decodeUint16s(rig.skinIndex), 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(decodeFloats(rig.skinWeight), 4));
  geometry.setIndex(new THREE.BufferAttribute(part.index, 1));

  // three enables skinning from the mesh type itself; the old `material.skinning` flag is gone.
  const material = makeMaterial(part.meta, options.materialOverrides?.[part.meta.id]);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = part.meta.id;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.part = part.meta;

  const { skeleton, root } = buildSkeleton(rig);
  mesh.add(root);
  mesh.bind(skeleton);

  group.add(mesh);
  // Scale on the MESH so the bones parented to it scale with the skin, and offset on the group so
  // the figure lands feet-at-zero. The offset is already expressed in normalised units, which is
  // why it must not sit under the same scale again.
  mesh.scale.setScalar(rig.normalise.scale);
  group.position.set(rig.normalise.offset[0], rig.normalise.offset[1], rig.normalise.offset[2]);

  const mixer = new THREE.AnimationMixer(mesh);
  const clips = buildClips(rig);
  let current: THREE.AnimationAction | null = null;

  const play = (which: string | number, fadeSeconds = 0.25): boolean => {
    const clip = typeof which === 'number' ? clips[which] : clips.find((c) => c.name === which);
    if (!clip) return false;
    const next = mixer.clipAction(clip);
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.reset();
    if (current && current !== next && fadeSeconds > 0) {
      // Cross-fade rather than cut: a hard switch between two looping clips pops on the first frame.
      next.crossFadeFrom(current, fadeSeconds, false).play();
    } else {
      current?.stop();
      next.play();
    }
    current = next;
    return true;
  };

  if (clips.length) play(0, 0);
  const rigged: RiggedModel = {
    group, mesh, mixer, clips, play,
    update: (dt: number) => mixer.update(dt),
  };
  group.userData.rigged = rigged;
  // Matches the static build's contract, which passes elapsed seconds; the mixer wants a delta.
  group.userData.update = (_elapsed: number, delta?: number) => mixer.update(delta ?? 0);
  return rigged;
}
