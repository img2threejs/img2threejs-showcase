import * as THREE from 'three';
import {
  createTqCharacter,
  prepareTqCharacter,
  isTqCharacterReady,
  type TqCharacter,
} from './createTqCharacter';
import { createStageLights } from './lighting';
import { SkillDirector, SKILLS, type VfxGains } from './skills';
import { COSTUME_REGIONS, REGIONS, SIGNATURE, type RegionId } from './characterPalette';

/**
 * Tq — a Three Kingdoms officer, rigged, split and lit from her own measured palette.
 *
 * This is the gallery entry point. The reconstruction itself lives in the modules beside this file;
 * everything here is the wiring the showcase runtime asks for: a synchronous `build`, a look-dev
 * rig, a `prewarm` for the fetch and decode, and the `sculptRuntime` surfaces the demo page reads to
 * build its panel.
 *
 * The model is ONE skeleton driving FIVE skinned meshes — crimson lacquer, gold filigree, indigo
 * cloth, hair and skin. The playground export was a single merged shell; splitting it by vertex
 * partition (never by decimation, which would invalidate the per-vertex joint weights) is what lets
 * the outfit be toggled piece by piece here without the costume drifting off the body underneath.
 *
 * `build` returns a group that is EMPTY when the data has not arrived yet and fills itself in when
 * `prewarm` resolves — the same shape the other data-heavy demos in this gallery use. Everything the
 * panel reads is published up front and describes the model whether or not it has landed, so the
 * controls render immediately and simply do nothing until there is something to control.
 */

export const TQ_CAMERA = {
  position: [1.7695, 1.045, 5.0558] as [number, number, number],
  target: [0, 0.95, 0] as [number, number, number],
  fov: 30,
};

export interface TqModelOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** Fetch and decode the embedded rig and surfaces. Awaiting it more than once is a no-op. */
export async function prewarmTq(): Promise<void> {
  await prepareTqCharacter();
}

/** The palette-driven three-point rig. The viewer skips its own studio lights when this is used. */
export function createTqLookDevLights(): THREE.Group {
  return createStageLights(1.9).group;
}

/**
 * The effect multipliers start at the authored strength.
 *
 * They are exposed to the panel rather than baked because the effects are the point of this demo:
 * the sliders let a reader take the aura to zero and see that the rim really was doing the
 * silhouette work, or take the embers up and watch additive blending fuse them into a single bright
 * mass — a failure this build had to correct once already.
 */
const DEFAULT_GAINS: VfxGains = { embers: 1, trails: 1, aura: 1, glow: 1, light: 1 };

/** Clips worth offering on their own, beside the four skills. */
const CLIP_ACTIONS = [
  { id: 'clip:idle', label: 'Idle', clip: 'preset:biped:dance_02' },
  { id: 'clip:walk', label: 'Walk', clip: 'preset:walk' },
  { id: 'clip:run', label: 'Run', clip: 'preset:run' },
  { id: 'clip:sprint', label: 'Sprint', clip: 'preset:biped:flee_02' },
  { id: 'clip:jump', label: 'Jump', clip: 'preset:jump' },
  { id: 'clip:hurt', label: 'Hurt', clip: 'preset:hurt' },
];

const IDLE_CLIP = 'preset:biped:dance_02';

export function createTqModel(options: TqModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'tq';

  // Live once the data lands; every control below tolerates them being null until then.
  let character: TqCharacter | null = null;
  let director: SkillDirector | null = null;

  const gains: VfxGains = { ...DEFAULT_GAINS };
  const hidden = new Set<RegionId>();

  /**
   * The camera, captured from the render itself.
   *
   * Trails have to face the viewer and the cast seal has to turn toward them, so the effects need a
   * camera every frame — but `userData.tick(dt, elapsed)` does not carry one, and reaching into the
   * viewer's internals would couple this demo to the gallery's private state. `three` hands the
   * camera to `onBeforeRender` as part of the normal render, so a drawn object can catch it there.
   *
   * It has to be a Mesh: `onBeforeRender` fires as an object is rendered, and a bare `Object3D` is
   * never rendered, so the hook would never run. This one is a single degenerate point with an
   * invisible material — drawn, but costing nothing and showing nothing.
   */
  let activeCamera: THREE.Camera | null = null;
  const probe = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  probe.name = 'tq:camera-probe';
  probe.frustumCulled = false;
  probe.renderOrder = -1000;
  probe.onBeforeRender = (_renderer, _scene, camera): void => {
    activeCamera = camera;
  };
  // Not a part of the model: keep it out of the parts inspector and the explode layout.
  probe.userData.explodeWithParent = true;
  root.add(probe);

  const fallbackCamera = new THREE.PerspectiveCamera(TQ_CAMERA.fov, 1, 0.01, 200);
  fallbackCamera.position.set(...TQ_CAMERA.position);

  // --- animation ---------------------------------------------------------------------------------
  let active = 'idle';
  const listeners = new Set<(id: string) => void>();
  const announce = (next: string): void => {
    active = next;
    for (const listener of listeners) listener(next);
  };

  const animationController = {
    actions: [
      ...SKILLS.map((skill) => ({ id: skill.id, label: skill.name, loop: false })),
      ...CLIP_ACTIONS.map((entry) => ({ id: entry.id, label: entry.label, loop: true })),
    ],
    get active(): string { return active; },
    play: (id: string): void => {
      if (SKILLS.some((s) => s.id === id)) {
        director?.cast(id);
        announce(id);
        return;
      }
      const clip = CLIP_ACTIONS.find((c) => c.id === id);
      if (clip) {
        director?.release();
        character?.play(clip.clip, 0.3);
        announce(id);
      }
    },
    stop: (): void => {
      director?.release();
      character?.play(IDLE_CLIP, 0.3);
      announce('idle');
    },
    subscribe: (listener: (id: string) => void): (() => void) => {
      listeners.add(listener);
      listener(active);
      return () => { listeners.delete(listener); };
    },
  };

  // --- outfit ------------------------------------------------------------------------------------
  // Described from the measured palette rather than from the built meshes, so the panel can render
  // its list before the geometry has arrived. The gate re-measures the real split against these.
  const outfit = {
    title: 'Outfit',
    note: 'Each piece is its own skinned mesh on one shared skeleton. Hiding the armour leaves the head, hair and hands — the shell has no body modelled underneath it.',
    items: (Object.keys(REGIONS) as RegionId[]).map((id) => ({
      id,
      label: REGIONS[id].label,
      swatch: REGIONS[id].measuredHex,
      note: `${REGIONS[id].measuredTriangles.toLocaleString()} tris · ${
        COSTUME_REGIONS.includes(id) ? 'costume' : 'body'
      }`,
    })),
    isVisible: (id: string): boolean => !hidden.has(id as RegionId),
    set: (id: string, visible: boolean): void => {
      // Remembered here rather than read off the mesh, so a piece toggled while the model was still
      // loading is still hidden once it lands.
      if (visible) hidden.delete(id as RegionId);
      else hidden.add(id as RegionId);
      const mesh = character?.meshes.get(id as RegionId);
      if (mesh) mesh.visible = visible;
    },
  };

  // --- vfx ---------------------------------------------------------------------------------------
  const vfxParameters = {
    title: 'Skill VFX',
    note: 'Multipliers on what a skill fires. Cast a skill to see them take effect.',
    items: [
      { id: 'embers', label: 'Embers', min: 0, max: 2, step: 0.05, value: gains.embers, note: 'spark count and brightness' },
      { id: 'trails', label: 'Blade trail', min: 0, max: 2, step: 0.05, value: gains.trails, note: 'ribbon opacity' },
      { id: 'aura', label: 'Aura rim', min: 0, max: 2, step: 0.05, value: gains.aura, note: 'silhouette fresnel' },
      { id: 'glow', label: 'Filigree glow', min: 0, max: 3, step: 0.05, value: gains.glow, note: 'emissive on the gold' },
      { id: 'light', label: 'Accent light', min: 0, max: 2, step: 0.05, value: gains.light, note: 'the lamp a cast drives' },
    ],
    set: (id: string, value: number): void => {
      if (id in gains) gains[id as keyof VfxGains] = value;
      director?.setGains(gains);
    },
  };

  const runtime: Record<string, unknown> = {
    animationController,
    toggleGroups: outfit,
    parameters: vfxParameters,
    sockets: {},
    destructionGroups: {},
  };
  root.userData.sculptRuntime = runtime;

  // --- attach ------------------------------------------------------------------------------------
  const attach = (): void => {
    if (character) return;
    character = createTqCharacter({
      castShadow: options.castShadow ?? true,
      receiveShadow: options.receiveShadow ?? true,
    });
    const lights = createStageLights(character.height);
    director = new SkillDirector(character, lights);

    root.add(character.group, director.group);
    // The accent lamp is part of the effect, not of the look-dev rig, so it travels with the model.
    root.add(lights.accent);

    // A skill plays once and then releases itself; reflect that so the button does not stay lit.
    director.onRelease = () => {
      if (SKILLS.some((s) => s.id === active)) announce('idle');
    };

    // Replay whatever the panel was set to while the geometry was still in flight.
    for (const id of hidden) {
      const mesh = character.meshes.get(id);
      if (mesh) mesh.visible = false;
    }
    director.setGains(gains);
    character.play(IDLE_CLIP, 0);
    if (active !== 'idle') animationController.play(active);

    root.userData.height = character.height;
    root.userData.tqCharacter = character;
    root.userData.tqDirector = director;
    // `Record<group, meshName[]>` — the viewer iterates the value to label each part with its
    // module, so anything other than a list of names throws inside its part-list builder.
    runtime.destructionGroups = Object.fromEntries(
      [...character.meshes.entries()].map(([id, mesh]) => [id, [mesh.name]]),
    );
    runtime.sockets = Object.fromEntries(character.sockets);
  };

  root.userData.tick = (dt: number): void => {
    if (!character || !director) return;
    // Clamped: a backgrounded tab returns with a delta of several seconds, which would jump every
    // clip forward at once and fire a skill's whole timeline inside a single frame.
    const step = Math.min(dt, 0.05);
    // The character is stepped FIRST, so the sockets the effects read are already at this frame's
    // pose; the other order leaves every effect trailing one frame behind the hand it hangs from.
    character.update(step);
    director.update(step, activeCamera ?? fallbackCamera);
  };

  if (isTqCharacterReady()) attach();
  else void prepareTqCharacter().then(attach).catch(() => { /* the loader reports the failure */ });

  return root;
}

/** Region ids, for anything that wants to address the outfit without building the model first. */
export const TQ_REGIONS = Object.keys(REGIONS) as RegionId[];
export const TQ_SKILLS = SKILLS.map((s) => ({ id: s.id, name: s.name, title: s.title, clip: s.clip }));
export const TQ_SIGNATURE = SIGNATURE;
export type { TqCharacter };
