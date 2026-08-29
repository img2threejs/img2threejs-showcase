import * as THREE from 'three';
import {
  buildClips,
  buildSkeleton,
  createStudioLights,
  decodeFloats,
  decodeModel,
  decodeUint16s,
  preferredQuality,
  type DecodedPart,
  type EncodedModel,
  type EncodedRig,
  type Quality,
} from './meshCodec';
import { buildRegionGeometries, segmentCostume, SEAM_FALLOFF_HOPS, type Region, type SegmentationResult } from './costumeSegmentation';
import { createClothRig, planCostumeRig, type ClothRig, type VertexWeights } from './clothRig';
import { createFrostVfx, VFX_LAYERS, type FrostVfx, type VfxLayer } from './frostVfx';

/**
 * Luc Tuyet Ky — an ice-empress character rebuilt as code-only Three.js, with the costume split off
 * the body and driven by its own cloth solver.
 *
 * Provenance: reference image -> Tripo v3.1-20260211 measurement (task 9e8b722d) -> Tripo mesh
 * segmentation v2.0-20260430 -> img2threejs GLB fast lane. Geometry, per-vertex colour, the 41-joint
 * skeleton and all 18 clips are embedded; nothing is fetched at runtime.
 *
 * WHAT THIS FILE CHANGES ABOUT THE DOWNLOAD IT CAME FROM
 * ------------------------------------------------------
 * The playground shipped one SkinnedMesh: rigging merges the shell, so body and costume were the
 * same skin and the auto-rig's per-vertex weights decided how the gown moved. Measured on that skin,
 * 40% of vertices were dominated by leg twist joints out to a radius the leg does not reach — gown
 * panels bound to the shins — and the waist-length hair was dominated by Spine01 and the clavicles.
 * That is what made the costume follow the limbs: a kick lifted the skirt with the knee, a split
 * stance tore the front panel between L_Calf and R_Calf, and a shoulder roll sheared the hair.
 *
 * Here the shell is cut into three meshes on measured evidence (`costumeSegmentation`), the two
 * costume meshes are re-weighted onto joint rings of their own that hang from the pelvis and the head
 * (`clothRig`), and those rings are solved as verlet strands with limb colliders. The gown has no leg
 * weight left in it at all, so it can no longer be dragged; it swings because the solver gives it
 * inertia, and the legs can only push it out of the way.
 *
 * The frost package (`frostVfx`) is six generated layers — no texture is fetched, the one sprite is a
 * canvas gradient.
 */

export type LucTuyetKyQuality = Quality;

export const LUC_TUYET_KY_PARTS = ['body', 'dress', 'hair'] as const;

/** Framing that fits the whole figure at a 30-degree FOV. */
export const LUC_TUYET_KY_CAMERA = {
  position: [1.7695, 1.045, 5.0558] as [number, number, number],
  target: [0, 0.95, 0] as [number, number, number],
  fov: 30,
};

/** Clip names as they were retargeted, in the order the skeleton carries them. Empty before prewarm. */
export function lucTuyetKyClips(): string[] {
  return loaded?.rig.clips.map((clip) => clip.name) ?? [];
}

/** The clips worth surfacing in the viewer, with the labels a reader can act on. */
const actionId = (label: string): string => label.toLowerCase().replace(/\s+/g, '-');

const FEATURED_CLIPS: Array<{ clip: string; label: string }> = [
  { clip: 'preset:biped:dance_02', label: 'Dance' },
  { clip: 'preset:biped:dance_05', label: 'Spin' },
  { clip: 'preset:biped:front_kick_01', label: 'Front Kick' },
  { clip: 'preset:biped:flee_02', label: 'Run' },
  { clip: 'preset:biped:greet_01', label: 'Greet' },
  { clip: 'preset:biped:angry_01', label: 'Angry' },
  { clip: 'preset:biped:heart_pose', label: 'Heart Pose' },
  { clip: 'preset:biped:afraid', label: 'Afraid' },
  { clip: 'preset:biped:lift_heavy', label: 'Lift' },
  { clip: 'preset:biped:defeat_02', label: 'Defeat' },
];

/** The panel's buttons. Static, so they can be published before the rig payload lands. */
const FEATURED_ACTIONS: LucTuyetKyAction[] = FEATURED_CLIPS.map((entry) => ({
  id: actionId(entry.label), label: entry.label, loop: true,
}));

function loadLevel(quality: Quality): Promise<{ SURFACE_MODEL: EncodedModel; SURFACE_STREAM: string }> {
  switch (quality) {
    case 'high':
    default:
      return import('./surfaceData.high');
  }
}

let loaded: { quality: Quality; model: EncodedModel; stream: string; rig: EncodedRig } | null = null;
let decoded: { part: DecodedPart; segmentation: SegmentationResult } | null = null;

/**
 * Fetch the level of detail and run the segmentation once.
 *
 * The segmentation is the expensive part (a weld, an adjacency build and two flood fills over 160k
 * vertices, about 90 ms), and it does not depend on anything the scene knows, so it belongs here
 * rather than in `build` — the registry awaits `prewarm` before it builds, which is what keeps that
 * cost off the frame that puts the model on screen.
 */
export async function prewarmLucTuyetKy(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality !== quality) {
    // Both payloads are dynamic imports so the bundler gives each its own chunk. The rig alone is
    // 13 MB of keyframes and joint weights; statically importing it would put all of that in the
    // gallery's entry bundle, where every visitor pays for it whether or not they open this demo.
    const [surface, rig] = await Promise.all([loadLevel(quality), import('./rigData')]);
    loaded = { quality, model: surface.SURFACE_MODEL, stream: surface.SURFACE_STREAM, rig: rig.RIG };
    decoded = null;
  }
  if (!decoded) {
    const part = decodeModel(loaded.model, loaded.stream)[0];
    decoded = { part, segmentation: segmentCostume(part) };
  }
  return quality;
}

export function lucTuyetKyQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export interface LucTuyetKyOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Start the cloth solver enabled. Off shows the raw rebound pose, which is what a rig review wants. */
  cloth?: boolean;
  /** Build the frost layers. Off leaves a bare character for a likeness comparison. */
  vfx?: boolean;
}

export interface LucTuyetKyAction {
  id: string;
  label: string;
  loop: boolean;
}

export interface LucTuyetKyModel {
  group: THREE.Group;
  /** Pins the Hip's horizontal travel to its bind value; call after the mixer, before the cloth. */
  holdInPlace(): void;
  meshes: Record<Region, THREE.SkinnedMesh | null>;
  skeleton: THREE.Skeleton;
  mixer: THREE.AnimationMixer;
  cloth: ClothRig;
  vfx: FrostVfx | null;
}

/** Material for one region, from the medians the encoder measured, corrected per region. */
function makeRegionMaterial(region: Region, part: DecodedPart, castShadow: boolean): THREE.MeshStandardMaterial {
  const measured = part.meta.material;
  // The shell's single median reads the whole figure at once, so it lands between skin, satin and
  // lacquer and describes none of them. Splitting the mesh is what makes a per-region correction
  // possible at all, and these are the three the reference actually shows.
  const perRegion: Record<Region, { roughness: number; metalness: number; sheen?: number }> = {
    body: { roughness: 0.52, metalness: 0.02 },
    dress: { roughness: 0.34, metalness: 0.14 },
    hair: { roughness: 0.28, metalness: 0.05 },
  };
  const tuned = perRegion[region];
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: tuned.roughness,
    metalness: tuned.metalness,
    emissive: new THREE.Color(measured.emissive),
    side: measured.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    envMapIntensity: region === 'dress' ? 1.25 : 1,
  });
  material.name = `luc-tuyet-ky-${region}`;
  material.shadowSide = castShadow ? THREE.FrontSide : null;
  return material;
}

export function createLucTuyetKy(options: LucTuyetKyOptions = {}, host?: THREE.Group): LucTuyetKyModel {
  if (!loaded || !decoded) {
    throw new Error('call prewarmLucTuyetKy() and await it before createLucTuyetKy() — the level of detail is loaded on demand');
  }
  const { part, segmentation } = decoded;
  const RIG = loaded.rig;
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  // `host` lets the showcase factory hand in the group it already returned to the viewer, so the
  // figure lands inside the object the scene is holding rather than in a second one it never sees.
  const group = host ?? new THREE.Group();
  group.name = 'luc-tuyet-ky';
  // The figure carries the normalisation scale; the skeleton and every region mesh sit under it, so
  // the geometry is never edited out from under its own bind pose.
  const figure = new THREE.Group();
  figure.name = 'luc-tuyet-ky-figure';
  figure.scale.setScalar(RIG.normalise.scale);
  // Tripo returned this figure facing +X: the measured bind bounds are only 0.206 wide on X but
  // 0.709 on Z, and the dark hair mass sits at negative X behind the pale face. A quarter turn puts
  // the face down +Z, where the gallery's camera actually is — without it the demo opens on her
  // shoulder.
  figure.rotation.y = -Math.PI / 2;
  group.position.set(RIG.normalise.offset[0], RIG.normalise.offset[1], RIG.normalise.offset[2]);
  group.add(figure);

  const { bones: bodyBones, root } = buildSkeleton(RIG);
  figure.add(root);

  const regions = buildRegionGeometries(part, segmentation);
  const costume = planCostumeRig(part, regions, bodyBones);

  /*
   * One weight set per SOURCE vertex, applied to every mesh that holds a copy of it.
   *
   * This is what keeps the character watertight. Splitting the shell duplicates each border vertex
   * into two meshes, and the first revision let each copy take its own mesh's rule — the gown copy
   * onto the skirt joints, the body copy keeping the auto-rig's. They agreed in bind pose and then
   * came apart the moment anything moved: 1,094 shared vertices between body and gown, measured up
   * to 0.25 of figure height apart during a dance, which on screen is a hole at the waist with the
   * unlit inside of the model showing through it. Resolving weights from the source vertex instead
   * of from the mesh makes both copies identical by construction, so there is no gap to open.
   *
   * Away from the seam the body returns to its own weights over `SEAM_FALLOFF_HOPS` rings rather
   * than in one step, because a step would simply move the tear inward by one ring.
   */
  const sourceSkinIndex = decodeUint16s(RIG.skinIndex);
  const sourceSkinWeight = decodeFloats(RIG.skinWeight);

  const originalWeights = (source: number): VertexWeights => ({
    index: [
      sourceSkinIndex[source * 4], sourceSkinIndex[source * 4 + 1],
      sourceSkinIndex[source * 4 + 2], sourceSkinIndex[source * 4 + 3],
    ],
    weight: [
      sourceSkinWeight[source * 4], sourceSkinWeight[source * 4 + 1],
      sourceSkinWeight[source * 4 + 2], sourceSkinWeight[source * 4 + 3],
    ],
  });

  /** Mix two influence sets and keep the four heaviest, renormalised. */
  const mixWeights = (a: VertexWeights, b: VertexWeights, t: number): VertexWeights => {
    const pooled = new Map<number, number>();
    for (let k = 0; k < 4; k += 1) {
      if (a.weight[k] > 0) pooled.set(a.index[k], (pooled.get(a.index[k]) ?? 0) + a.weight[k] * (1 - t));
      if (b.weight[k] > 0) pooled.set(b.index[k], (pooled.get(b.index[k]) ?? 0) + b.weight[k] * t);
    }
    const ranked = [...pooled.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const total = ranked.reduce((sum, [, w]) => sum + w, 0) || 1;
    const index: [number, number, number, number] = [0, 0, 0, 0];
    const weight: [number, number, number, number] = [0, 0, 0, 0];
    ranked.forEach(([bone, w], k) => { index[k] = bone; weight[k] = w / total; });
    if (!ranked.length) weight[0] = 1;
    return { index, weight };
  };

  const weightForSource = (source: number): VertexWeights => {
    const region = segmentation.vertexRegion[source];
    if (region !== 0) {
      // Gown and hair proper: the ring rule alone, so no leg joint reaches them.
      return costume.ringWeightsAt(source, region as 1 | 2) ?? originalWeights(source);
    }
    const hop = segmentation.seamHop[source];
    if (hop === 0 || hop > SEAM_FALLOFF_HOPS) return originalWeights(source);
    const ring = costume.ringWeightsAt(source, segmentation.seamRegion[source] as 1 | 2);
    if (!ring) return originalWeights(source);
    return mixWeights(ring, originalWeights(source), hop / SEAM_FALLOFF_HOPS);
  };

  for (const region of regions) {
    const count = region.sourceVertex.length;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const { index, weight } = weightForSource(region.sourceVertex[i]);
      for (let k = 0; k < 4; k += 1) {
        skinIndex[i * 4 + k] = index[k];
        skinWeight[i * 4 + k] = weight[k];
      }
    }
    region.geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    region.geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }

  const meshes: Record<Region, THREE.SkinnedMesh | null> = { body: null, dress: null, hair: null };
  for (const region of regions) {
    const mesh = new THREE.SkinnedMesh(region.geometry, makeRegionMaterial(region.region, part, castShadow));
    mesh.name = `luc-tuyet-ky-${region.region}`;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    // The gown swings well outside its bind-pose bounds once the solver runs, and a bounding sphere
    // measured in bind space would cull it at the edge of frame exactly when it is most visible.
    mesh.frustumCulled = false;
    mesh.userData.region = region.region;
    figure.add(mesh);
    meshes[region.region] = mesh;
  }

  // Every inverse is derived here, from the assembled bind pose, rather than taken from the rig's
  // exported matrices: the figure sits under a scaled parent, and three's skinning shader only holds
  // together when each bone matrix is the identity in the pose the mesh was bound in.
  figure.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([...bodyBones, ...costume.bones]);
  for (const mesh of Object.values(meshes)) {
    if (mesh) mesh.bind(skeleton, mesh.matrixWorld.clone());
  }

  const cloth = createClothRig(costume.strands, bodyBones);
  cloth.enabled = options.cloth ?? true;
  cloth.reset();

  /**
   * Hold the figure over its own mark.
   *
   * These preset clips carry their travel on the Hip, and a lot of it: measured against the bind
   * pose, `flee_02` displaces that joint by 7.26 and `dance_02` by 5.68, against 0.05 for the front
   * kick. In a gallery viewer with a fixed camera the character simply leaves the frame — which is
   * exactly what the run clip did before this.
   *
   * The pin is done in WORLD space on purpose. Clamping the joint's local x and z looked equivalent
   * and did nothing, because the Hip's local axes are not the world's: the figure carries a quarter
   * turn and the skeleton its own bind rotations, so the clip's horizontal travel arrives largely on
   * the joint's local Y. Reading the world position, replacing its horizontal part and converting
   * back through the parent is axis-agnostic and cannot be wrong for the same reason.
   *
   * Only the horizontal components are pinned, so the vertical bob, the crouch and the weight shift
   * the clip authored all still play. It is locomotion in place, which is how a run cycle is meant to
   * be read in a viewer, not a flattened one.
   *
   * The one vertical intervention is a ceiling, and it is there for a measured defect rather than a
   * taste. Across the ten featured clips the hip's own high-water mark is the front kick's 1.132
   * against a bind height of 1.077 — about 5% of rise, which is all a biped that never leaves the
   * ground should have. `flee_02` reaches 1.829 in its top 5% of frames: a retarget spike, not a
   * leap, and on screen the whole figure floats most of a body height off the frost ring while her
   * feet keep running. Clamping at 6% clears every other clip's real motion untouched and holds that
   * one down. Nothing raises the hip, so a crouch — `lift_heavy` bottoms out at 0.534 — is unaffected.
   */
  const HIP_RISE_CEILING = 1.06;
  const hip = bodyBones.find((bone) => bone.name === 'Hip');
  figure.updateMatrixWorld(true);
  const hipBindWorld = hip ? new THREE.Vector3().setFromMatrixPosition(hip.matrixWorld) : null;
  const hipWorld = new THREE.Vector3();
  const parentInverse = new THREE.Matrix4();
  const holdInPlace = (): void => {
    if (!hip || !hipBindWorld || !hip.parent) return;
    hip.updateWorldMatrix(true, false);
    hipWorld.setFromMatrixPosition(hip.matrixWorld);
    hipWorld.x = hipBindWorld.x;
    hipWorld.z = hipBindWorld.z;
    hipWorld.y = Math.min(hipWorld.y, hipBindWorld.y * HIP_RISE_CEILING);
    parentInverse.copy(hip.parent.matrixWorld).invert();
    hip.position.copy(hipWorld.applyMatrix4(parentInverse));
    hip.updateWorldMatrix(false, true);
  };

  const mixer = new THREE.AnimationMixer(figure);

  const vfx = options.vfx === false
    ? null
    : createFrostVfx({
      height: part.meta.bounds.max[1] * RIG.normalise.scale,
      auraSources: (['dress', 'hair'] as const)
        .map((id) => meshes[id])
        .filter((mesh): mesh is THREE.SkinnedMesh => Boolean(mesh))
        .map((mesh) => ({
          geometry: mesh.geometry,
          skeleton,
          bindMatrix: mesh.bindMatrix.clone(),
          bindMatrixInverse: mesh.bindMatrixInverse.clone(),
        })),
      trailBones: ['L_Hand', 'R_Hand', 'L_Foot', 'R_Foot']
        .map((name) => bodyBones.find((bone) => bone.name === name))
        .filter((bone): bone is THREE.Bone => Boolean(bone)),
    });
  if (vfx) group.add(vfx.group);

  return { group, meshes, skeleton, mixer, cloth, vfx, holdInPlace };
}

/**
 * The showcase-facing factory: builds the model and hangs the viewer's runtime contracts off it.
 *
 * The viewer collects `userData.tick(dt, elapsed)` on its own and reads
 * `userData.sculptRuntime.animationController` to build the clip buttons, so wiring both here is
 * what makes the demo interactive without the page knowing anything about this character.
 */
/** Where the deferred build parks the real per-frame updater; see `createLucTuyetKyModel`. */
interface TickHolder { current: ((deltaSeconds: number, elapsedSeconds: number) => void) | null }

/**
 * The animation transport the detail page binds to, published before the rig exists.
 *
 * The page reads `sculptRuntime.animationController` and builds its clip buttons from
 * `controller.actions` at the moment it mounts the panel. An earlier revision created the controller
 * only once the 18 MB payload had decoded, so whether the buttons appeared at all came down to which
 * of two `prewarm` continuations happened to run first — and in the production build it lost every
 * time: the model animated on its own default clip and the panel stayed empty, with no way to pick a
 * clip. The action list is a static property of this character, so it is published immediately and
 * the transport behind it is swapped in later.
 */
interface ControllerShell {
  setActive(id: string): void;
  attach(play: (id: string) => void, stop: () => void, time: () => number): void;
}

function createControllerShell(group: THREE.Group, actions: LucTuyetKyAction[]): ControllerShell {
  let active = 'idle';
  let live: { play: (id: string) => void; stop: () => void; time: () => number } | null = null;
  /** A press that arrived before the rig did; replayed on attach so no input is silently dropped. */
  let pending: string | null = null;
  const listeners = new Set<(value: string) => void>();
  const announce = (): void => { for (const listener of listeners) listener(active); };

  group.userData.sculptRuntime ??= {};
  (group.userData.sculptRuntime as Record<string, unknown>).animationController = {
    actions: actions as ReadonlyArray<LucTuyetKyAction>,
    get active(): string { return active; },
    get time(): number { return live?.time() ?? 0; },
    play: (id: string): void => {
      if (live) live.play(id);
      else { pending = id; active = id; announce(); }
    },
    stop: (): void => {
      pending = null;
      if (live) live.stop();
      else { active = 'idle'; announce(); }
    },
    subscribe: (listener: (value: string) => void): (() => void) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };

  return {
    setActive: (id: string): void => { active = id; announce(); },
    attach: (play, stop, time): void => {
      live = { play, stop, time };
      play(pending ?? active !== 'idle' ? (pending ?? active) : actions[0]?.id);
      pending = null;
    },
  };
}

function assembleLucTuyetKy(group: THREE.Group, options: LucTuyetKyOptions, tickHolder: TickHolder, shell: ControllerShell): void {
  const model = createLucTuyetKy(options, group);
  const { mixer, cloth, vfx, skeleton, holdInPlace } = model;
  if (!loaded) throw new Error('createLucTuyetKy() cannot have succeeded without a prewarm');
  const clips = buildClips(loaded.rig);
  const byName = new Map(clips.map((clip) => [clip.name, clip] as const));

  const clipForAction = new Map(
    FEATURED_CLIPS
      .filter((entry) => byName.has(entry.clip))
      .map((entry) => [actionId(entry.label), byName.get(entry.clip) as THREE.AnimationClip]),
  );

  let current: THREE.AnimationAction | null = null;
  const setActive = shell.setActive;
  const play = (id: string): void => {
    const clip = clipForAction.get(id);
    if (!clip) return;
    const next = mixer.clipAction(clip);
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.reset();
    if (current && current !== next) next.crossFadeFrom(current, 0.28, false).play();
    else next.play();
    current = next;
    setActive(id);
  };

  const stop = (): void => {
    mixer.stopAllAction();
    current = null;
    // Put the skeleton back in bind pose, then drop the cloth's stored velocity: without the reset
    // the panels would keep the swing they had at the moment the clip was cut and settle from a pose
    // the body is no longer in.
    skeleton.pose();
    cloth.reset();
    holdInPlace();
    setActive('idle');
  };

  tickHolder.current = (deltaSeconds: number, elapsedSeconds: number): void => {
    mixer.update(deltaSeconds);
    holdInPlace();
    // Strictly after the mixer and the in-place pin: the solver reads the anchor joints the clip has
    // just posed, and running it first would always leave the cloth one frame behind the body.
    cloth.update(deltaSeconds);
    vfx?.update(deltaSeconds, elapsedSeconds);
  };
  // Exposed for the rig-tuning harness in scripts/, which sweeps the cloth constants against the
  // measured hem envelope rather than against anyone's eye.
  group.userData.clothStrands = cloth.strands;
  const runtime = group.userData.sculptRuntime as Record<string, unknown>;
  runtime.route = 'img2threejs GLB fast lane — pure Three.js, no loader and no runtime fetch. Geometry, per-vertex colour, the 41-joint skeleton and all 18 clips are embedded as code.';
  // NOT reassigned: the shell published at build() is the object the page is already bound to.
  runtime.costumeSeparation = {
    why: 'The auto-rig bound the gown to the leg twist joints and the hair to Spine01 and the clavicles, so the costume was dragged by the limbs and the front panel tore in a split stance.',
    meshes: (['body', 'dress', 'hair'] as const).map((region) => ({
      region,
      triangles: decoded?.segmentation.counts[region].triangles ?? 0,
      vertices: decoded?.segmentation.counts[region].vertices ?? 0,
    })),
    cut: 'Seeded on the measured bimodal radial histogram of the shell (gown panels sit outside r=0.085 of figure height where the leg reaches 0.05), grown along mesh edges and stopped at the belt line.',
    straddlingTriangles: decoded?.segmentation.straddlingTriangles ?? 0,
    seam: `every border vertex resolves its weights from the source vertex, so the ${SEAM_FALLOFF_HOPS}-ring falloff closes the body/costume seam exactly rather than approximately`,
    costumeJoints: cloth.bones.length,
    legInfluenceOnCostume: 0,
    solver: 'verlet strands, hard length constraint, sphere colliders on both thighs and both calves',
  };
  runtime.sourceAnimations = clips.map((clip, index) => ({ index, name: clip.name, duration: clip.duration }));

  if (vfx) {
    runtime.frostVfx = {
      layers: VFX_LAYERS.map((layer) => ({ id: layer, label: layer })),
      isOn: (layer: VfxLayer) => vfx.isLayerOn(layer),
      setLayer: (layer: VfxLayer, on: boolean) => vfx.setLayer(layer, on),
      get intensity(): number { return vfx.intensity; },
      set intensity(value: number) { vfx.intensity = value; },
      assets: 'none — the one sprite is a canvas gradient built at runtime',
    };
    group.userData.disposeFrostVfx = () => vfx.dispose();
  }

  // Hand the live transport to the controller the page has been holding since `build()` returned,
  // and honour a button the viewer pressed while the payload was still decoding.
  shell.attach(play, stop, () => current?.time ?? 0);
}

/**
 * The group the viewer holds, returned before the payload has necessarily landed.
 *
 * `build()` is synchronous by the registry's contract and the detail page calls it BEFORE `prewarm`
 * settles, so a factory that insisted on the payload being present would throw straight out of
 * `renderDemo` and leave the page behind its own loader forever — which is exactly what an earlier
 * revision of this file did. The group therefore comes back empty and fills itself in, the same way
 * every other prewarm demo in the gallery behaves; the page re-reads `sculptRuntime` afterwards, so
 * the clip buttons appear when the rig does.
 */
export function createLucTuyetKyModel(options: LucTuyetKyOptions = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = 'luc-tuyet-ky';
  group.userData.sculptRuntime ??= {};

  /*
   * `userData.tick` is installed ONCE, here, and never replaced.
   *
   * The viewer resolves its tickers by walking the scene and keeping the function objects it finds.
   * An earlier revision published a placeholder from `build()` and then assigned the real updater
   * over it when the payload landed — and whichever of the two `prewarm` chains resolved first
   * decided whether the viewer was holding the live function or the stub. When it lost that race the
   * model rendered perfectly and simply never moved: every clip button worked, the mixer advanced
   * nothing, and the figure sat in bind pose. A stable wrapper around a mutable slot has no race to
   * lose, because the reference the viewer captured is always the one that gets the call.
   */
  const tickHolder: TickHolder = { current: null };
  // Published now, from the static featured list, so the clip buttons exist from the first frame.
  const shell = createControllerShell(group, FEATURED_ACTIONS);
  group.userData.tick = (deltaSeconds: number, elapsedSeconds: number): void => {
    tickHolder.current?.(deltaSeconds, elapsedSeconds);
  };
  // The contract the download shipped, kept so `updateLucTuyetKy(group, elapsed)` still works.
  group.userData.update = (elapsed: number, delta?: number): void => {
    tickHolder.current?.(delta ?? 0, elapsed);
  };

  if (loaded && decoded) assembleLucTuyetKy(group, options, tickHolder, shell);
  else void prewarmLucTuyetKy().then(() => assembleLucTuyetKy(group, options, tickHolder, shell));
  return group;
}

/**
 * A three-point studio rig, cooled toward the reference's palette.
 *
 * The key is neutral so the skin stays readable; the fill and rim are the gown's own blues, which is
 * what makes the white satin read as ice rather than as paper.
 */
export function createLucTuyetKyLookDevLights(): THREE.Group {
  const height = 1.9;
  const lights = createStudioLights(height);
  lights.name = 'luc-tuyet-ky-lights';

  const rim = new THREE.DirectionalLight(0x7fc4ff, 1.6);
  rim.position.set(-1.4, height * 0.95, -1.9);
  lights.add(rim);

  const bounce = new THREE.HemisphereLight(0xcfe8ff, 0x1a2436, 0.55);
  lights.add(bounce);

  // Sits just under the hem, so the frost disc reads as lit from the ground the character froze.
  const ground = new THREE.PointLight(0x3f8fd8, 2.2, height * 1.4, 2);
  ground.position.set(0, 0.08, 0);
  lights.add(ground);

  return lights;
}

export function makeLucTuyetKyBackground(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#0a1520');
    gradient.addColorStop(0.55, '#12283c');
    gradient.addColorStop(1, '#060a10');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Call once per frame with the elapsed time in seconds to run the model's own motion. */
export function updateLucTuyetKy(group: THREE.Group, elapsedSeconds: number, deltaSeconds?: number): void {
  const update = group.userData.update as ((elapsed: number, delta?: number) => void) | undefined;
  update?.(elapsedSeconds, deltaSeconds);
}
