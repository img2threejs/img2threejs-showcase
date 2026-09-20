/**
 * Sora showcase adapter — the runtime the gallery consumes.
 *
 * Responsibilities:
 *   - Preload both skin rigs, then swap which rig is mounted.
 *   - Expose the full 44-clip catalog plus the synthetic `outfit-change`
 *     action as an `AnimationController`. The viewer in `pages/demo.ts`
 *     reads `root.userData.sculptRuntime.animationController`.
 *   - Drive the surface reveal while holding the current pose stable.
 *   - Drive the rig ticker through the same path the other rigged demos
 *     use (`group.userData.tick`).
 */
import * as THREE from 'three';
import { buildRiggedModel, type RiggedModel } from './meshCodec';
import { preserveSkinVolume } from './volumeSkinning';
import { repairElbowSkinning } from './elbowSkinning';
import { applySoraSurfaceAppearance } from './surfaceAppearance';
import { disposeSoraSelectableParts, installSoraSelectableParts } from './soraParts';
import { RIG as RIG_SKIN_A } from './rigData.skin-a';
import { RIG as RIG_SKIN_B } from './rigData.skin-b';
import {
  SURFACE_MODEL as SURFACE_MODEL_A,
  SURFACE_STREAM as SURFACE_STREAM_A,
} from './surfaceData.skin-a';
import {
  SURFACE_MODEL as SURFACE_MODEL_B,
  SURFACE_STREAM as SURFACE_STREAM_B,
} from './surfaceData.skin-b';
import { SORA_ACTIONS, OUTFIT_CHANGE_ID } from './soraClips';
import { SORA_PARTS, type SoraSkinId } from './createSoraModel';
import { createSoraOutfitVfx } from './soraVfx';
import { createSoraSkillVfx, SORA_SKILLS } from './soraSkillVfx';

export interface SoraOutfitState {
  skinId: SoraSkinId;
  switching: boolean;
}

export interface SoraOutfitController {
  readonly label: string;
  readonly state: SoraOutfitState;
  switchSkin(): boolean;
  subscribe(listener: (state: SoraOutfitState) => void): () => void;
}

export type SoraAnimationController = {
  actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
  readonly active: string;
  play: (id: string) => void;
  stop: () => void;
  subscribe: (listener: (active: string) => void) => () => void;
  readonly sora: SoraOutfitController;
};

interface SoraShowcaseOptions {
  /** Initial skin; the viewer mounts this one on first build. */
  initialSkin?: SoraSkinId;
}

interface BoundRig {
  rigged: RiggedModel;
  skinId: SoraSkinId;
}

function buildRig(skinId: SoraSkinId): BoundRig {
  const rigged = skinId === 'default'
    ? buildRiggedModel(SURFACE_MODEL_A, SURFACE_STREAM_A, RIG_SKIN_A, {
        castShadow: true, receiveShadow: true,
      })
    : buildRiggedModel(SURFACE_MODEL_B, SURFACE_STREAM_B, RIG_SKIN_B, {
        castShadow: true, receiveShadow: true,
      });
  applySoraSurfaceAppearance(rigged.mesh, skinId);
  // Only the showcase advances this mixer; nested viewer tickers would
  // double its speed and survive removal of the outgoing skin.
  delete rigged.group.userData.tick;
  const updateSkin = skinId === 'kingdom-key' ? preserveSkinVolume(rigged.mesh) : null;
  const updateElbows = skinId === 'kingdom-key' ? repairElbowSkinning(rigged.mesh) : null;
  installSoraSelectableParts(rigged.mesh);
  const hip = rigged.mesh.skeleton.bones.find((bone) => bone.name === 'Hip')!;
  const placement = rigged.group.position.clone();
  const restHip = rigged.group.worldToLocal(hip.getWorldPosition(new THREE.Vector3()));
  const movingHip = new THREE.Vector3();
  rigged.update = (delta: number): void => {
    rigged.mixer.update(delta);
    // Present source locomotion in place: preserve every bone/keyframe and
    // vertical jump, while preventing Run/Shoot from leaving the fixed camera.
    rigged.group.updateWorldMatrix(true, true);
    rigged.group.worldToLocal(hip.getWorldPosition(movingHip));
    rigged.group.position.x = placement.x + restHip.x - movingHip.x;
    rigged.group.position.z = placement.z + restHip.z - movingHip.z;
    rigged.group.updateMatrixWorld(true);
    updateSkin?.();
    updateElbows?.();
  };
  return { skinId, rigged };
}

function disposeRig(bound: BoundRig): void {
  bound.rigged.mixer.stopAllAction();
  disposeSoraSelectableParts(bound.rigged.mesh);
  bound.rigged.mixer.uncacheRoot(bound.rigged.mesh);
  bound.rigged.mesh.skeleton.dispose();
  bound.rigged.mesh.geometry.dispose();
  bound.rigged.mesh.customDepthMaterial?.dispose();
  bound.rigged.mesh.customDistanceMaterial?.dispose();
  const materials = Array.isArray(bound.rigged.mesh.material)
    ? bound.rigged.mesh.material
    : [bound.rigged.mesh.material];
  for (const material of materials) material.dispose();
}

/**
 * The instance the gallery mounts into a scene. Per-frame work runs on its
 * `update(delta)` and the controller is published on
 * `root.userData.sculptRuntime`.
 */
export function createSoraShowcase(
  options: SoraShowcaseOptions = {},
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'sora';

  const initialSkin: SoraSkinId = options.initialSkin ?? 'default';
  let current: BoundRig = buildRig(initialSkin);
  let incoming: BoundRig | null = null;
  root.add(current.rigged.group);

  const vfx = createSoraOutfitVfx();
  root.add(vfx.group);
  const skills = createSoraSkillVfx();
  // Follow the existing strike-VFX convention: sibling effects are not body
  // parts and must not participate in the inspector's explode layout.
  root.addEventListener('added', () => root.parent?.add(skills.group));
  let skillsEnabled = true;
  let playRevision = 0;
  let timedRig: BoundRig | null = null;
  let timedId = '';
  let timedAction: THREE.AnimationAction | null = null;

  let activeId = 'preset:biped:idle';
  const animationListeners = new Set<(active: string) => void>();
  const outfitListeners = new Set<(state: SoraOutfitState) => void>();

  const notifyAnimation = (): void => {
    playRevision++;
    skills.clear();
    for (const listener of animationListeners) listener(activeId);
  };
  const outfitState = (): SoraOutfitState => ({
    skinId: current.skinId,
    switching: incoming !== null,
  });
  const notifyOutfit = (): void => {
    const state = outfitState();
    for (const listener of outfitListeners) listener(state);
  };

  const playOnBoundRig = (bound: BoundRig, id: string, fadeSeconds = 0.22): boolean => {
    if (id === OUTFIT_CHANGE_ID) return false;
    return bound.rigged.play(id, fadeSeconds);
  };
  const playOnEveryRig = (id: string): boolean => {
    const playedCurrent = playOnBoundRig(current, id);
    if (incoming) playOnBoundRig(incoming, id);
    return playedCurrent;
  };
  const fallBackToIdle = (): void => {
    if (incoming || playOnEveryRig('preset:biped:idle')) {
      activeId = 'preset:biped:idle';
      notifyAnimation();
    }
  };

  const outfitController: SoraOutfitController = {
    label: 'Switch Skin (Outfit →)',
    get state(): SoraOutfitState {
      return outfitState();
    },
    switchSkin(): boolean {
      if (incoming || vfx.active) return false;
      const targetSkin: SoraSkinId =
        current.skinId === 'default' ? 'kingdom-key' : 'default';
      const target = buildRig(targetSkin);
      const requestedClip =
        activeId === OUTFIT_CHANGE_ID ? 'preset:biped:idle' : activeId;
      if (!playOnBoundRig(target, requestedClip, 0)) {
        playOnBoundRig(target, 'preset:biped:idle', 0);
      }
      const sourceClip = current.rigged.clips.find((clip) => clip.name === requestedClip);
      const targetClip = target.rigged.clips.find((clip) => clip.name === requestedClip);
      if (sourceClip && targetClip) {
        const sourceAction = current.rigged.mixer.clipAction(sourceClip);
        const targetAction = target.rigged.mixer.clipAction(targetClip);
        targetAction.time = sourceClip.duration > 0
          ? (sourceAction.time / sourceClip.duration) * targetClip.duration : 0;
        target.rigged.update(0);
      }
      incoming = target;
      root.add(target.rigged.group);

      const started = vfx.start(current.rigged.mesh, target.rigged.mesh, () => {
        const completed = incoming;
        if (!completed) return;
        const outgoing = current;
        root.remove(outgoing.rigged.group);
        current = completed;
        incoming = null;
        disposeRig(outgoing);
        if (activeId !== requestedClip) current.rigged.play(activeId, 0.2);
        notifyOutfit();
      });
      if (!started) {
        root.remove(target.rigged.group);
        disposeRig(target);
        incoming = null;
        return false;
      }
      notifyOutfit();
      skills.clear();
      return true;
    },
    subscribe(listener: (state: SoraOutfitState) => void): () => void {
      outfitListeners.add(listener);
      listener(outfitState());
      return () => {
        outfitListeners.delete(listener);
      };
    },
  };

  const controller: SoraAnimationController = {
    actions: SORA_ACTIONS
      .filter((action) => action.id !== OUTFIT_CHANGE_ID)
      .map((action) => ({
        id: action.id,
        label: SORA_SKILLS[action.id]
          ? `${action.label} · ${SORA_SKILLS[action.id].name}` : action.label,
        loop: !action.oneShot,
      })),
    get active(): string {
      return activeId;
    },
    play(id: string): void {
      const action = SORA_ACTIONS.find((entry) => entry.id === id);
      if (!action) {
        fallBackToIdle();
        return;
      }
      if (id === OUTFIT_CHANGE_ID) {
        outfitController.switchSkin();
        return;
      }
      if (incoming) {
        activeId = id;
        notifyAnimation();
        return;
      }
      if (playOnEveryRig(id)) {
        activeId = id;
        notifyAnimation();
        return;
      }
      fallBackToIdle();
    },
    stop(): void {
      if (incoming) {
        activeId = 'preset:biped:idle';
        notifyAnimation();
      } else {
        fallBackToIdle();
      }
    },
    subscribe(listener: (active: string) => void): () => void {
      animationListeners.add(listener);
      listener(activeId);
      return () => {
        animationListeners.delete(listener);
      };
    },
    sora: outfitController,
  };

  root.userData.tick = (deltaSeconds: number): void => {
    if (!incoming) {
      current.rigged.update(deltaSeconds);
      if (timedRig !== current || timedId !== activeId) {
        timedRig = current;
        timedId = activeId;
        const clip = current.rigged.clips.find((entry) => entry.name === activeId);
        timedAction = clip ? current.rigged.mixer.clipAction(clip) : null;
      }
      if (skillsEnabled && timedAction) {
        skills.update(current.rigged.mesh, activeId, timedAction.time,
          timedAction.getClip().duration, playRevision);
      }
    }
    vfx.update(deltaSeconds);
  };

  root.userData.sculptRuntime = {
    animationController: controller,
    outfitController,
    strikeVfx: {
      title: 'Sora-inspired VFX',
      elements: [{ id: 'sora', label: 'Sora skills' }, { id: 'off', label: 'Off' }],
      get current(): string { return skillsEnabled ? 'sora' : 'off'; },
      setElement(id: string): void {
        if (id !== 'sora' && id !== 'off') return;
        skillsEnabled = id === 'sora';
        skills.clear();
      },
    },
    provenance:
      'img2threejs 1.5.2 playground · Hyper3D MCP measurement · GLB fast lane. '
      + 'Default skin: 51,827 triangles, 41 bones, 44 retargeted biped clips. '
      + 'Second skin ("Kingdom Key"): 51,906 triangles on the same skeleton. '
      + 'The standalone outfit control runs a code-only head-to-toe molt: '
      + 'the reveal front begins above the hair, accelerates toward the feet, '
      + 'and replaces the outgoing surface with a glowing dissolving edge.',
    clips: SORA_ACTIONS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      duration: entry.duration,
      group: entry.group,
      ...(entry.synthetic ? { synthetic: true } : {}),
    })),
    switchSkin: outfitController.switchSkin,
    currentSkin: (): SoraSkinId => outfitController.state.skinId,
    sora: true,
    selectableParts: SORA_PARTS,
  };

  // Begin with a stationary pose and no combat effects.
  current.rigged.play(activeId, 0);

  return root;
}

/** Helper for callers that want to grab the latest controller synchronously. */
export function soraControllerFromRoot(root: THREE.Group): SoraAnimationController | null {
  const runtime = root.userData.sculptRuntime as
    | { animationController?: SoraAnimationController }
    | undefined;
  return runtime?.animationController ?? null;
}
