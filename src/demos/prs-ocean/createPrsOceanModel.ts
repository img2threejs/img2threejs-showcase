import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Viewer } from '../../scene';
import { createOceanMeasuredModel } from './measured/factory';
import { surfaceMeta } from './measured/surfaceData';
import {
  createGuitarStrings,
  type GuitarStringInspection,
  type GuitarStringsController,
} from './experiment/strings';
import {
  createOceanFinish,
  type OceanFinishHandle,
  type OceanFinishInspection,
} from './experiment/oceanFinish';

const TARGET_HEIGHT = 5.25;
const TARGET_CENTER_Y = TARGET_HEIGHT / 2;
const SOURCE_ROTATION_Y = -Math.PI / 2;
const ACTIONS = [
  { id: 'water-waves', label: 'Water Waves', loop: true },
  { id: 'string-motion', label: 'String Motion', loop: true },
  { id: 'pluck-strings', label: 'Pluck Strings', loop: false },
  { id: 'combined', label: 'Ocean + Strings', loop: true },
] as const;
type OceanActionId = (typeof ACTIONS)[number]['id'];
type ActiveAction = OceanActionId | 'idle';

const STRING_LOOP_INTERVAL = 1.85;
const PLUCK_DURATION = 2.65;

export interface PrsOceanAction {
  readonly id: string;
  readonly label: string;
  readonly loop: boolean;
}

export interface PrsOceanInspection {
  readonly active: boolean;
  readonly action: ActiveAction;
  readonly disposed: boolean;
  readonly contextLost: boolean;
  readonly reducedMotion: boolean;
  readonly hidden: boolean;
  readonly waterTime: number;
  readonly waterEnabled: boolean;
  readonly stringCount: number;
  readonly endpointErrorMax: number;
  readonly strings: GuitarStringInspection;
  readonly finish: OceanFinishInspection | null;
  readonly source: {
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly sourceSha256: string;
  };
}

export interface PrsOceanAnimationController {
  readonly actions: ReadonlyArray<PrsOceanAction>;
  readonly active: string;
  play(name: string): void;
  stop(): void;
  subscribe(listener: (active: string) => void): () => void;
}

type OceanRuntimeDiagnostics = {
  readonly inspect: () => PrsOceanInspection;
  readonly waterTime: number;
  readonly stringCount: number;
  readonly endpointErrorMax: number;
  readonly endPointError: number;
  readonly active: boolean;
  readonly disposed: boolean;
  readonly contextLost: boolean;
};

type OceanRuntime = {
  animationController: PrsOceanAnimationController;
  destructionGroups: Record<string, string[]>;
  provenance: {
    route: string;
    exactnessTier: string;
    inferred: string[];
  };
  diagnostics: OceanRuntimeDiagnostics;
};

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (
  Array.isArray(mesh.material) ? mesh.material : [mesh.material]
);

function findSourceMesh(root: THREE.Group): THREE.Mesh {
  let source: THREE.Mesh | undefined;
  root.traverse((object) => {
    if (!source && object instanceof THREE.Mesh) source = object;
  });
  if (!source) throw new Error('PRS Ocean measured surface did not contain a mesh.');
  return source;
}

function resetStrings(strings: GuitarStringsController): void {
  // The source detail controller intentionally exposes enable/freeze as its reset boundary.
  // Turning it off restores every tube to its pinned rest path, then turning it back on keeps
  // the strings visible and ready for the next action.
  strings.setEnabled(false);
  strings.setEnabled(true);
}

function createPrsOceanAssembly(): {
  root: THREE.Group;
  sourceMesh: THREE.Mesh;
  strings: GuitarStringsController;
  finish: OceanFinishHandle;
} {
  const measured = createOceanMeasuredModel(true);
  const sourceMesh = findSourceMesh(measured);
  sourceMesh.name = 'guitar-body-neck-and-hardware';
  const parent = sourceMesh.parent;
  if (!parent) throw new Error('PRS Ocean source mesh has no measured node parent.');

  const strings = createGuitarStrings(sourceMesh);
  // Strings stay in the measured node's local frame. The node's authored matrix is retained;
  // this add is deliberately after the source factory has installed that matrix.
  parent.add(strings.group);
  const finish = createOceanFinish(sourceMesh);

  // The delivered baseline is the source appearance: no smooth/polished pass and no water phase.
  // The animation controller opts into these states explicitly.
  finish.setPolished(false);
  finish.setWaterEnabled(false);

  const root = new THREE.Group();
  root.name = 'prs-ocean';
  root.add(measured);

  // Orient the supplied model frame so its +X face looks down the viewer's canonical +Z front
  // axis. Measure after strings are attached so the assembly is one consistent height.
  root.rotation.y = SOURCE_ROTATION_Y;
  root.updateMatrixWorld(true);
  const sourceBounds = new THREE.Box3().setFromObject(root);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const scale = TARGET_HEIGHT / Math.max(sourceSize.y, 1e-6);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const scaledBounds = new THREE.Box3().setFromObject(root);
  const scaledCenter = scaledBounds.getCenter(new THREE.Vector3());
  root.position.set(-scaledCenter.x, TARGET_CENTER_Y - scaledCenter.y, -scaledCenter.z);
  root.updateMatrixWorld(true);

  return { root, sourceMesh, strings, finish };
}

/**
 * Build the measured Ocean guitar in the showcase's synchronous demo contract.
 *
 * The heavy payload is already inside this code-split module, so `build()` returns a complete
 * assembly after `loadDemo()` resolves. No runtime GLB, image map or late-binding promise is used.
 */
export function createPrsOceanModel(): THREE.Group {
  const assembly = createPrsOceanAssembly();
  const { root, sourceMesh, strings } = assembly;
  let finish: OceanFinishHandle | null = assembly.finish;
  let disposed = false;
  let contextLost = false;
  let restoredEnvironmentTarget: THREE.WebGLRenderTarget | null = null;
  let activeAction: ActiveAction = 'idle';
  let stringClock = 0;
  let pluckRemaining = 0;
  let waterTime = 0;
  let waterBeforeLoss = false;
  let polishedBeforeLoss = false;
  // A hidden/reduced/context-lost interval must not turn into a single large
  // visible step when the viewer becomes available again. The first thawed
  // ticker call is a boundary marker; motion resumes on the following call.
  let motionWasFrozen = false;
  let mountedViewer: Viewer | null = null;
  let mountedRemove: (() => void) | null = null;
  const listeners = new Set<(active: string) => void>();

  const reducedMotionMatches = (): boolean => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const pageHidden = (): boolean => (
    typeof document !== 'undefined' && document.hidden
  );
  const motionFrozen = (): boolean => contextLost || pageHidden() || reducedMotionMatches();

  const announce = (): void => {
    for (const listener of listeners) listener(activeAction);
  };

  const setWater = (enabled: boolean): void => {
    finish?.setWaterEnabled(enabled);
  };

  const setPolished = (enabled: boolean): void => {
    finish?.setPolished(enabled);
  };

  const stopToStatic = (): void => {
    activeAction = 'idle';
    stringClock = 0;
    pluckRemaining = 0;
    waterTime = 0;
    setWater(false);
    setPolished(false);
    resetStrings(strings);
    announce();
  };

  const playAction = (name: string): void => {
    if (disposed) return;
    if (name === 'idle' || name === 'stop') {
      stopToStatic();
      return;
    }
    if (!ACTIONS.some((action) => action.id === name)) return;
    const action = name as OceanActionId;
    activeAction = action;
    stringClock = 0;
    pluckRemaining = action === 'pluck-strings' ? PLUCK_DURATION : 0;
    setPolished(false);
    setWater(action === 'water-waves' || action === 'combined');
    resetStrings(strings);
    if (action === 'string-motion' || action === 'combined' || action === 'pluck-strings') {
      strings.strum(undefined, action === 'pluck-strings' ? 1 : 0.58);
    }
    announce();
  };

  const animationController: PrsOceanAnimationController = {
    actions: ACTIONS,
    get active(): string {
      return activeAction;
    },
    play: playAction,
    stop: stopToStatic,
    subscribe(listener): () => void {
      listeners.add(listener);
      listener(activeAction);
      return () => listeners.delete(listener);
    },
  };

  const inspect = (): PrsOceanInspection => {
    const stringInspection = strings.inspect();
    const finishInspection = finish?.inspect() ?? null;
    return {
      active: activeAction !== 'idle',
      action: activeAction,
      disposed,
      contextLost,
      reducedMotion: reducedMotionMatches(),
      hidden: pageHidden(),
      waterTime,
      waterEnabled: finishInspection?.waterEnabled ?? false,
      stringCount: stringInspection.stringCount,
      endpointErrorMax: stringInspection.endpointErrorMax,
      strings: stringInspection,
      finish: finishInspection,
      source: {
        vertexCount: surfaceMeta.vertexCount,
        triangleCount: surfaceMeta.triangleCount,
        sourceSha256: surfaceMeta.sourceSha256,
      },
    };
  };

  const diagnostics: OceanRuntimeDiagnostics = {
    inspect,
    get waterTime(): number { return waterTime; },
    get stringCount(): number { return strings.inspect().stringCount; },
    get endpointErrorMax(): number { return strings.inspect().endpointErrorMax; },
    get endPointError(): number { return strings.inspect().endpointErrorMax; },
    get active(): boolean { return activeAction !== 'idle'; },
    get disposed(): boolean { return disposed; },
    get contextLost(): boolean { return contextLost; },
  };

  const disposeModel = (): void => {
    if (disposed) return;
    disposed = true;
    const remove = mountedRemove;
    mountedRemove = null;
    mountedViewer = null;
    remove?.();
    listeners.clear();
    restoredEnvironmentTarget?.dispose();
    restoredEnvironmentTarget = null;
    finish?.dispose();
    finish = null;
    strings.dispose();
  };

  const rebuildEnvironment = (viewer: Viewer): void => {
    restoredEnvironmentTarget?.dispose();
    restoredEnvironmentTarget = null;
    const pmrem = new THREE.PMREMGenerator(viewer.renderer);
    const roomEnvironment = new RoomEnvironment();
    try {
      restoredEnvironmentTarget = pmrem.fromScene(roomEnvironment, 0.04);
      viewer.scene.environment = restoredEnvironmentTarget.texture;
    } finally {
      roomEnvironment.dispose();
      pmrem.dispose();
    }
  };

  const releaseOceanTextureBookkeeping = (): void => {
    // The finish registers this custom property so the generic resource walker sees its DataTexture.
    // Remove the property before disposing the finish on context loss; the next restored finish owns
    // a fresh source cache and cannot accidentally retain a stale WebGL texture handle.
    for (const material of materialsOf(sourceMesh)) {
      const tracked = material as THREE.Material & { oceanSourceTexture?: THREE.Texture };
      if (tracked.oceanSourceTexture) delete tracked.oceanSourceTexture;
    }
  };

  const releaseModelResourcesForContextLoss = (): void => {
    // Three rebuilds its WebGL resource managers after a context restore, but the old dispose
    // listeners remain attached to model resources. Release those listeners while the context is
    // lost so route teardown cannot ask the restored context to delete stale buffers or VAOs. The
    // dispose calls clear GPU bookkeeping only; BufferGeometry attributes and controller state stay
    // intact for the restored finish and string materials to reuse.
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const registerTexture = (value: unknown): void => {
      if (!value || typeof value !== 'object' || !('isTexture' in value)) return;
      const texture = value as THREE.Texture;
      if (texture.isTexture === true) textures.add(texture);
    };

    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
      meshMaterials.forEach((material) => {
        materials.add(material);
        Object.values(material as unknown as Record<string, unknown>).forEach(registerTexture);
        if (material instanceof THREE.ShaderMaterial) {
          Object.values(material.uniforms).forEach((uniform) => registerTexture(uniform.value));
        }
      });
    });

    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed || contextLost) return;
    contextLost = true;
    motionWasFrozen = true;
    const finishState = finish?.inspect();
    waterBeforeLoss = finishState?.waterEnabled ?? false;
    polishedBeforeLoss = finishState?.polished ?? false;
    releaseOceanTextureBookkeeping();
    finish?.dispose();
    finish = null;
    releaseModelResourcesForContextLoss();
    restoredEnvironmentTarget?.dispose();
    restoredEnvironmentTarget = null;
  };

  const onContextRestored = (): void => {
    const viewer = mountedViewer;
    if (disposed || !contextLost || !viewer) return;
    try {
      rebuildEnvironment(viewer);
      finish = createOceanFinish(sourceMesh);
      finish.setPolished(polishedBeforeLoss);
      finish.setWaterEnabled(waterBeforeLoss);
      strings.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const position = object.geometry.getAttribute('position');
        if (position) position.needsUpdate = true;
      });
      contextLost = false;
    } catch (error) {
      // Keep the runtime marked lost so its diagnostics expose the concrete restore failure while
      // preventing a stale ticker from writing into a half-rebuilt material set.
      console.error('PRS Ocean context restore failed', error);
    }
  };

  const mountViewerInteraction = (viewer: Viewer): (() => void) => {
    if (disposed) return disposeModel;
    if (mountedViewer === viewer && mountedRemove) return disposeModel;
    if (mountedViewer && mountedViewer !== viewer) {
      // One assembly must never share controllers or context listeners across viewers.
      disposeModel();
      return disposeModel;
    }
    mountedViewer = viewer;
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    const remove = (): void => {
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
    };
    mountedRemove = remove;
    return (): void => {
      if (mountedRemove !== remove) return;
      mountedRemove = null;
      mountedViewer = null;
      remove();
      disposeModel();
    };
  };

  root.userData.tick = (dt: number): void => {
    if (disposed) return;
    if (motionFrozen()) {
      motionWasFrozen = true;
      return;
    }
    if (motionWasFrozen) {
      motionWasFrozen = false;
      return;
    }
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.05) : 0;
    if (step <= 0) return;

    if (activeAction === 'water-waves' || activeAction === 'combined') {
      finish?.update(step);
      waterTime += step;
    }

    if (activeAction === 'string-motion' || activeAction === 'combined' || activeAction === 'pluck-strings') {
      strings.update(step);
    }

    if (activeAction === 'string-motion' || activeAction === 'combined') {
      stringClock += step;
      if (stringClock >= STRING_LOOP_INTERVAL) {
        stringClock = 0;
        strings.strum(undefined, 0.58);
      }
    } else if (activeAction === 'pluck-strings') {
      pluckRemaining = Math.max(0, pluckRemaining - step);
      if (pluckRemaining === 0) stopToStatic();
    }
  };

  root.userData.dispose = disposeModel;
  root.userData.mountViewerInteraction = mountViewerInteraction;
  root.userData.sculptRuntime = {
    animationController,
    diagnostics,
    destructionGroups: {
      'guitar-body': ['guitar-body-neck-and-hardware'],
      strings: Array.from({ length: 6 }, (_, index) => `guitar-string-${index + 1}`),
    },
    provenance: {
      route: surfaceMeta.route,
      exactnessTier: 'force-measured',
      inferred: [
        'The single measured GLB mesh is preserved as one measured body, neck and hardware assembly.',
        'The source +X face is presented through a -PI/2 Y orientation for the showcase front camera.',
        'Six string tubes are authored detail because the measured source has no complete string parts.',
        'Depth on hidden faces remains limited to what the single measured GLB view establishes.',
      ],
    },
  } satisfies OceanRuntime;
  return root;
}

/** The Ocean look-dev rig from the approved source-facing camera. */
export function createPrsOceanLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'prs-ocean-lookdev-lights';

  const key = new THREE.DirectionalLight(0xffe4c4, 3.6);
  key.position.set(4.5, 7, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 16;
  lights.add(key);

  const fill = new THREE.DirectionalLight(0x49ccf2, 1.2);
  fill.position.set(-5, 2.5, 1.5);
  lights.add(fill);

  const rim = new THREE.DirectionalLight(0x0a9bd1, 15);
  rim.position.set(-2.8, 3.4, -4.5);
  lights.add(rim);

  lights.add(new THREE.HemisphereLight(0x9be5ff, 0x020810, 1.05));
  return lights;
}
