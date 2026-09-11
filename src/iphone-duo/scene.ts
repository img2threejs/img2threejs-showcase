import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { createMetalStudioEnvironment } from './studioEnvironment';
import { createIphoneDuoModel, isIphoneDuoScreen, type IphoneDuoScreen } from './createIphoneDuoModel';
import { loadEncodedIphoneDuoHyper3dSource } from './loadEncodedSource';
import {
  IPHONE_DUO_FINISHES,
  IPHONE_DUO_FINISH_PALETTES,
  createFinishWeights,
  isIphoneDuoFinish,
  normalizeFinishWeights,
  weightedFinishValue,
  type IphoneDuoFinish,
  type IphoneDuoFinishWeights,
} from './palette';
import {
  IPHONE_DUO_RELEASE_DURATIONS,
  IPHONE_DUO_HINGE_CUT,
  sampleIphoneDuoRelease,
  type IphoneDuoReleaseFrame,
  type IphoneDuoReleaseSequence,
} from './releaseTimeline';
let areaLightTexturesReady = false;

export type { IphoneDuoReleaseSequence } from './releaseTimeline';

export type { IphoneDuoFinish, IphoneDuoFinishWeights } from './palette';
export type { IphoneDuoScreen } from './createIphoneDuoModel';
export type IphoneDuoProvider = 'articulated' | 'hyper3d';
export type IphoneDuoView = 'reset' | 'front' | 'back' | 'orbit';

export interface IphoneDuoAnimationState {
  sequence: IphoneDuoReleaseSequence;
  time: number;
  duration: number;
  playing: boolean;
  loop: boolean;
  vfxEnabled: boolean;
}

export interface IphoneDuoSceneState {
  fold: number;
  finish: IphoneDuoFinish;
  screen: IphoneDuoScreen;
  provider: IphoneDuoProvider;
  ready: boolean;
  articulated: boolean;
  loading: boolean;
  error: string | null;
}

export interface IphoneDuoSceneDiagnostics extends IphoneDuoSceneState {
  finishMix: number;
  finishWeights: IphoneDuoFinishWeights;
  finishPalette: {
    label: string;
    hex: string;
    study: boolean;
  };
  finishTransitioning: boolean;
  animation: IphoneDuoAnimationState;
  contextLost: boolean;
  renderer: {
    available: boolean;
    info: {
      triangles: number;
      calls: number;
      points: number;
      lines: number;
    };
    triangles: number;
    width: number;
    height: number;
    pixelRatio: number;
  };
  errors: string[];
}

export interface IphoneDuoSceneController {
  setFold(degrees: number): void;
  setFinish(finish: IphoneDuoFinish): void;
  setScreen(screen: IphoneDuoScreen): void;
  setProvider(provider: IphoneDuoProvider): Promise<void>;
  setView(view: IphoneDuoView): void;
  orbit(deltaRadians: number): void;
  resetView(): void;
  setReducedMotion(reducedMotion: boolean): void;
  play(): void;
  pause(): void;
  replay(): void;
  seek(time: number): void;
  setSequence(sequence: IphoneDuoReleaseSequence): void;
  setLoop(loop: boolean): void;
  setVfx(enabled: boolean): void;
  retry(): Promise<void>;
  inspect(): IphoneDuoSceneDiagnostics;
  dispose(): void;
}

export interface IphoneDuoSceneOptions {
  container: HTMLElement;
  reducedMotion: boolean;
  onLoading?: (provider: IphoneDuoProvider) => void;
  onReady?: (state: IphoneDuoSceneState) => void;
  onStateChange?: (state: IphoneDuoSceneState) => void;
  onAnimationChange?: (state: IphoneDuoAnimationState) => void;
  onError?: (message: string) => void;
}

interface DuoHandle {
  setFold?: (degrees: number) => void;
  setFinish?: (finish: IphoneDuoFinish) => void;
  setScreen?: (screen: IphoneDuoScreen) => void;
  setFinishMix?: (amount: number) => void;
  setFinishWeights?: (weights: Partial<IphoneDuoFinishWeights>) => void;
  setDisplayBlur?: (amount: number) => void;
  setCoverBlur?: (amount: number) => void;
  getParts?: () => Record<string, THREE.Object3D>;
  dispose?: () => void;
  capabilities?: {
    fold?: boolean;
    finish?: boolean;
    screen?: boolean;
  };
}

interface CameraPreset {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const PROVIDER_ROTATION_Y: Record<IphoneDuoProvider, number> = {
  articulated: 0,
  hyper3d: 0,
};

const clampFold = (value: number): number => THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 180);

function lerpFinishWeights(
  from: IphoneDuoFinishWeights,
  to: IphoneDuoFinishWeights,
  amount: number,
): IphoneDuoFinishWeights {
  const result = {} as IphoneDuoFinishWeights;
  const mix = THREE.MathUtils.clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  (Object.keys(from) as IphoneDuoFinish[]).forEach((finish) => {
    result[finish] = THREE.MathUtils.lerp(from[finish], to[finish], mix);
  });
  return normalizeFinishWeights(result);
}

function asDuoHandle(root: THREE.Group): DuoHandle | null {
  const candidate = root.userData.duo as Partial<DuoHandle> | undefined;
  if (!candidate || typeof candidate.setFold !== 'function') return null;
  return candidate as DuoHandle;
}

function disposeObjectGraph(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<ImageBitmap>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materialList) {
      materials.add(material);
      Object.values(material as unknown as Record<string, unknown>).forEach((value) => {
        if (!value || typeof value !== 'object' || !('isTexture' in value)) return;
        const texture = value as THREE.Texture & { image?: unknown };
        if (texture.isTexture !== true) return;
        textures.add(texture);
        const image = texture.image;
        if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
          images.add(image as ImageBitmap);
        }
      });
    }
  });
  for (const texture of textures) texture.dispose();
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

function disposeEnvironmentScene(environment: THREE.Scene): void {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  environment.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materialList) materials.add(material);
  });
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

function makeContactShadow(): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The contact shadow canvas could not be created');
  context.save();
  context.scale(1, 0.5);
  const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(23, 24, 25, 0.34)');
  gradient.addColorStop(0.52, 'rgba(23, 24, 25, 0.14)');
  gradient.addColorStop(1, 'rgba(23, 24, 25, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  context.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.7, 2.8), material);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, -1.44, 0.08);
  shadow.renderOrder = -1;
  return shadow;
}

function removeAndDisposeShadow(shadow: THREE.Mesh): void {
  shadow.removeFromParent();
  shadow.geometry.dispose();
  const material = shadow.material as THREE.MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
}

function makePreset(position: [number, number, number], target: [number, number, number]): CameraPreset {
  const aim = new THREE.Vector3(...target);
  return { position: new THREE.Vector3(...position).sub(aim).multiplyScalar(2.5).add(aim), target: aim };
}

const CAMERA_PRESETS: Record<IphoneDuoView, CameraPreset> = {
  reset: makePreset([0, 1.28, 8], [0, 1.28, 0]),
  front: makePreset([0, 1.28, 8], [0, 1.28, 0]),
  back: makePreset([0, 1.28, -8], [0, 1.28, 0]),
  orbit: makePreset([-4.7, 2.8, 5.7], [0, 1.25, 0]),
};

export function createIphoneDuoScene(options: IphoneDuoSceneOptions): IphoneDuoSceneController {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'WebGL could not be initialized';
    options.onError?.(reason);
    return createUnavailableController(options, reason);
  }

  const scene = new THREE.Scene();
  // A long lens preserves the source's small depth-dependent size changes while opening.
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(2 / 20)), 1, 1, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  if (!areaLightTexturesReady) {
    RectAreaLightUniformsLib.init();
    areaLightTexturesReady = true;
  }
  const macroLight = new THREE.RectAreaLight(0xfff8e9, 0, 8, 1.2);
  // A pair of camera-side softboxes keeps the polished enclosure readable at grazing angles.
  // Their low White level preserves the measured rear-panel exposure; Night receives the
  // additional lift because its blue-black metal has much less diffuse response.
  const nearRailFill = new THREE.RectAreaLight(0xd9e7f5, 0, 6, 1.6);
  const farRailFill = new THREE.RectAreaLight(0xc7d8eb, 0, 6, 1.6);
  const rearShoulderFill = new THREE.RectAreaLight(0xf0e9df, 0, 4.2, 1.6);
  rearShoulderFill.position.set(0, 1.9, -4.2);
  rearShoulderFill.lookAt(0, 1.28, 0);
  const shadow = makeContactShadow();
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  const fillLight = new THREE.DirectionalLight(0xffffff, 2.4);
  fillLight.castShadow = true;
  fillLight.shadow.mapSize.set(1024, 1024);
  fillLight.shadow.camera.left = -4.5;
  fillLight.shadow.camera.right = 4.5;
  fillLight.shadow.camera.top = 4.5;
  fillLight.shadow.camera.bottom = -3.5;
  fillLight.shadow.camera.near = 0.5;
  fillLight.shadow.camera.far = 24;
  fillLight.shadow.camera.updateProjectionMatrix();
  fillLight.shadow.bias = -0.00018;
  fillLight.shadow.normalBias = 0.004;
  fillLight.shadow.radius = 2.5;
  const whiteSoftFill = new THREE.PointLight(0xffffff, 180, 0, 2);
  whiteSoftFill.position.set(0, 5, -3.5);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0);
  const finishSweepLight = new THREE.DirectionalLight(0xbfd8ff, 0);
  const ambientLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.setClearColor(0xf3f1eb, 0);
  renderer.domElement.setAttribute('aria-label', 'Interactive iPhone Duo 3D model');
  renderer.domElement.setAttribute('role', 'img');
  options.container.appendChild(renderer.domElement);

  keyLight.position.set(4.5, 7, 5.5);
  // Light the opposite product face with a separate soft fill. This keeps components readable
  // through a full orbit while the lower image-based ambient level preserves directional contrast.
  fillLight.position.set(-4.5, 6, -4.2);
  rimLight.position.set(2, 5.5, -6);
  scene.add(
    keyLight,
    fillLight,
    fillLight.target,
    whiteSoftFill,
    rimLight,
    finishSweepLight,
    ambientLight,
    macroLight,
    nearRailFill,
    farRailFill,
    rearShoulderFill,
    shadow,
  );
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  controls.minDistance = 20 / 3;
  controls.maxDistance = 20 / 0.6;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI - 0.28;
  controls.enablePan = false;

  let pmrem: THREE.PMREMGenerator | null = null;
  let environmentTarget: THREE.WebGLRenderTarget | null = null;
  let disposed = false;
  let contextLost = false;
  let reducedMotion = options.reducedMotion;
  let activeRoot: THREE.Group | null = null;
  let activeDuo: DuoHandle | null = null;
  let activeProvider: IphoneDuoProvider = 'articulated';
  let currentFold = 0;
  let targetFold = 0;
  let currentFinish: IphoneDuoFinish = 'white';
  let currentScreen: IphoneDuoScreen = 'desert';
  let currentFinishWeights = createFinishWeights('white');
  let currentFinishMix = currentFinishWeights.night;
  let loading = false;
  let errorMessage: string | null = null;
  let loadToken = 0;

  const syncCameraSideLighting = (): void => {
    if (activeProvider !== 'articulated') {
      fillLight.castShadow = false;
      nearRailFill.intensity = 0;
      farRailFill.intensity = 0;
      rearShoulderFill.intensity = 0;
      return;
    }
    fillLight.castShadow = true;
    const view = camera.position.clone().sub(controls.target);
    if (view.lengthSq() < 1e-6) return;
    view.normalize();
    const horizontalView = view.clone();
    horizontalView.y = 0;
    if (horizontalView.lengthSq() < 1e-6) horizontalView.set(0, 0, 1);
    horizontalView.normalize();
    const side = new THREE.Vector3(-horizontalView.z, 0, horizontalView.x);
    const center = controls.target.clone().add(new THREE.Vector3(0, 0.04, 0));
    const lightBase = center.clone().addScaledVector(view, 4.6).add(new THREE.Vector3(0, 1.35, 0));
    nearRailFill.position.copy(lightBase).addScaledVector(side, 2.5);
    farRailFill.position.copy(lightBase).addScaledVector(side, -2.5);
    nearRailFill.lookAt(center);
    farRailFill.lookAt(center);
    const finishLift = weightedFinishValue(currentFinishWeights, (palette) => palette.lighting.railLift);
    nearRailFill.intensity = THREE.MathUtils.lerp(0.10, 0.52, finishLift);
    farRailFill.intensity = THREE.MathUtils.lerp(0.045, 0.24, finishLift);
    rearShoulderFill.intensity = THREE.MathUtils.lerp(0.14, 0.42, finishLift);
  };
  let animationFrame = 0;
  let releaseSequence: IphoneDuoReleaseSequence = 'display';
  let releaseTime = 0;
  let releasePlaying = false;
  let releaseLoop = false;
  let releaseVfxEnabled = true;
  let stageVisible = false;
  let hasAutoPlayed = false;
  let lastAnimationAnnouncement = -Infinity;
  let animationAnnouncementTimer: number | null = null;
  let lastRenderTime = 0;
  let releaseFrame: IphoneDuoReleaseFrame = sampleIphoneDuoRelease(releaseSequence, 0);
  let macroLightReleaseActive = false;
  let baseCameraHalfWidth = 2;
  const updateCameraAspect = (): void => {
    camera.aspect = Math.max(options.container.clientWidth, 1) / Math.max(options.container.clientHeight, 1);
  };
  const savedCameraPosition = new THREE.Vector3();
  const savedCameraTarget = new THREE.Vector3();
  let savedCameraZoom = 1;
  let restoringContext = false;
  let foldTransition: { startedAt: number; duration: number; from: number; to: number } | null = null;
  let finishTransition: {
    startedAt: number;
    duration: number;
    from: IphoneDuoFinishWeights;
    to: IphoneDuoFinishWeights;
  } | null = null;
  let viewTransition: { startedAt: number; duration: number; fromPosition: THREE.Vector3; fromTarget: THREE.Vector3; toPosition: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  const errors: string[] = [];
  const resizeObserver = new ResizeObserver(() => resize());

  const animationState = (): IphoneDuoAnimationState => ({
    sequence: releaseSequence,
    time: releaseTime,
    duration: IPHONE_DUO_RELEASE_DURATIONS[releaseSequence],
    playing: releasePlaying,
    loop: releaseLoop,
    vfxEnabled: releaseVfxEnabled,
  });

  const clearAnimationAnnouncementTimer = (): void => {
    if (animationAnnouncementTimer === null) return;
    window.clearTimeout(animationAnnouncementTimer);
    animationAnnouncementTimer = null;
  };

  const publishAnimation = (): void => {
    if (disposed) return;
    animationAnnouncementTimer = null;
    lastAnimationAnnouncement = performance.now();
    options.onAnimationChange?.(animationState());
  };

  const announceAnimation = (force = false): void => {
    const now = performance.now();
    if (force) {
      clearAnimationAnnouncementTimer();
      publishAnimation();
      return;
    }
    const elapsed = now - lastAnimationAnnouncement;
    if (elapsed >= 100) {
      clearAnimationAnnouncementTimer();
      publishAnimation();
      return;
    }
    if (animationAnnouncementTimer !== null) return;
    animationAnnouncementTimer = window.setTimeout(publishAnimation, Math.max(0, 100 - elapsed));
  };

  const state = (): IphoneDuoSceneState => ({
    fold: currentFold,
    finish: currentFinish,
    screen: currentScreen,
    provider: activeProvider,
    ready: Boolean(activeRoot && !contextLost),
    articulated: activeDuo?.capabilities?.fold === true,
    loading,
    error: errorMessage,
  });

  const announceState = (): void => options.onStateChange?.(state());

  const recordError = (message: string): void => {
    errorMessage = message;
    errors.push(message);
    while (errors.length > 8) errors.shift();
    options.onError?.(message);
    announceState();
  };

  const rebuildEnvironment = (): void => {
    environmentTarget?.dispose();
    pmrem?.dispose();
    const environment = createMetalStudioEnvironment();
    pmrem = new THREE.PMREMGenerator(renderer);
    environmentTarget = pmrem.fromScene(environment);
    scene.environment = environmentTarget.texture;
    scene.environmentIntensity = 0.85;
    disposeEnvironmentScene(environment);
  };

  const resize = (): void => {
    const width = Math.max(options.container.clientWidth, 1);
    const height = Math.max(options.container.clientHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    const aspect = width / height;
    // The source opens to roughly 4.16 world units wide. Give narrow stages enough vertical
    // span to keep both native leaves in frame while retaining the established three-unit
    // product height on desktop.
    const verticalSpan = Math.max(4, 4.45 / aspect);
    const halfVerticalSpan = verticalSpan / 2;
    baseCameraHalfWidth = halfVerticalSpan * aspect;
    updateCameraAspect();
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfVerticalSpan / 20));
    camera.updateProjectionMatrix();
  };

  const disposeActiveRoot = (): void => {
    if (!activeRoot) return;
    if (activeDuo?.dispose) activeDuo.dispose();
    else disposeObjectGraph(activeRoot);
    activeRoot.removeFromParent();
    activeRoot = null;
    activeDuo = null;
  };

  const fitRootToStage = (root: THREE.Group, provider: IphoneDuoProvider): void => {
    root.position.set(0, 0, 0);
    root.rotation.set(0, PROVIDER_ROTATION_Y[provider], 0);
    root.scale.setScalar(1);
    root.updateMatrixWorld(true);
    const initialBounds = new THREE.Box3().setFromObject(root);
    const initialSize = initialBounds.getSize(new THREE.Vector3());
    const scale = initialSize.y > 0.001 ? THREE.MathUtils.clamp(2.98 / initialSize.y, 0.04, 4) : 1;
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    const center = bounds.getCenter(new THREE.Vector3());
    root.position.set(-center.x, 1.28 - center.y, -center.z);
    root.userData.iphoneDuoPresentation = {
      provider,
      normalizedHeight: 2.98,
      sourceBounds: {
        min: initialBounds.min.toArray(),
        max: initialBounds.max.toArray(),
      },
    };
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = provider === 'articulated'
        ? object.userData.iphoneDuoCameraShadowCaster === true
        : true;
      // The imported Apple asset contains thin native display layers. Receiving the stage
      // shadow on those layers creates black self-shadow lines over the cover artwork.
      mesh.receiveShadow = provider === 'articulated'
        ? object.userData.iphoneDuoCameraShadowReceiver === true
        : true;
      mesh.frustumCulled = true;
    });
    root.updateMatrixWorld(true);
  };

  const syncFinishState = (): void => {
    if (activeDuo?.capabilities?.finish !== true) return;
    const modelState = activeRoot?.userData.duo as {
      finish?: unknown;
      finishWeights?: Partial<IphoneDuoFinishWeights>;
    } | undefined;
    if (modelState?.finish !== currentFinish) {
      // setFinish owns the model's discrete finish metadata and also updates its visual mix.
      // Restore the scene's current weighted visual state immediately so a mid-transition sync
      // never jumps to an endpoint. This keeps reversals and context-restored roots continuous.
      activeDuo.setFinish?.(currentFinish);
      if (modelState && modelState.finish !== currentFinish) modelState.finish = currentFinish;
    }
    if (activeDuo.setFinishWeights) activeDuo.setFinishWeights(currentFinishWeights);
    else activeDuo.setFinishMix?.(currentFinishMix);
  };

  const syncScreenState = (): void => {
    if (activeDuo?.capabilities?.screen !== true) return;
    const modelState = activeRoot?.userData.duo as { screen?: IphoneDuoScreen } | undefined;
    if (modelState?.screen === currentScreen) return;
    activeDuo.setScreen?.(currentScreen);
  };

  const applyModelState = (): void => {
    if (activeDuo?.capabilities?.fold === true) activeDuo.setFold?.(currentFold);
    syncFinishState();
    syncScreenState();
    activeRoot?.updateMatrixWorld(true);
    if (activeDuo && activeRoot) {
      const bounds = new THREE.Box3().setFromObject(activeRoot);
      const center = bounds.getCenter(new THREE.Vector3());
      activeRoot.position.x -= center.x;
      activeRoot.position.y += 1.28 - center.y;
      activeRoot.position.z -= center.z;
      activeRoot.updateMatrixWorld(true);
    }
  };

  const applyFinishLighting = (): void => {
    const lighting = {
      softFill: weightedFinishValue(currentFinishWeights, (palette) => palette.lighting.softFill),
      macroPostCut: weightedFinishValue(currentFinishWeights, (palette) => palette.lighting.macroPostCut),
    };
    syncFinishState();
    // Keep a restrained rear softbox at the Night endpoint. It restores the source's upper
    // rear-shell gradient and capsule shoulder without changing the already-balanced White view.
    whiteSoftFill.intensity = lighting.softFill;
    if (macroLightReleaseActive && releaseFrame.sequence === 'hinge' && releaseFrame.time >= IPHONE_DUO_HINGE_CUT) {
      macroLight.intensity = lighting.macroPostCut;
    }
    syncCameraSideLighting();
  };

  const applyFinishWeights = (input: Partial<IphoneDuoFinishWeights>): void => {
    currentFinishWeights = normalizeFinishWeights(input);
    currentFinishMix = currentFinishWeights.night;
    applyFinishLighting();
  };

  const sampleFinishTransition = (now: number): void => {
    if (!finishTransition || activeProvider !== 'articulated' || activeDuo?.capabilities?.finish !== true) {
      finishSweepLight.intensity = 0;
      return;
    }
    const progress = THREE.MathUtils.clamp(
      (now - finishTransition.startedAt) / finishTransition.duration,
      0,
      1,
    );
    const eased = progress * progress * (3 - 2 * progress);
    applyFinishWeights(lerpFinishWeights(finishTransition.from, finishTransition.to, eased));
    const sweep = Math.sin(Math.PI * eased);
    finishSweepLight.intensity = releaseVfxEnabled ? 0.13 * sweep : 0;
    finishSweepLight.position.set(-4.2 + 8.4 * eased, 4.6, 4.4 - 4.8 * eased);
    if (progress >= 1) {
      applyFinishWeights(finishTransition.to);
      finishTransition = null;
      finishSweepLight.intensity = 0;
      announceState();
    }
  };

  const applyReleaseFrame = (frame: IphoneDuoReleaseFrame, applyCamera = true): void => {
    releaseFrame = frame;
    currentFold = activeDuo?.capabilities?.fold === true ? frame.fold : 0;
    targetFold = currentFold;
    foldTransition = null;
    if (activeRoot && activeProvider === 'articulated') {
      activeRoot.rotation.set(...frame.camera.rootRotation);
    }
    applyModelState();
    activeDuo?.setDisplayBlur?.(releaseVfxEnabled ? frame.displayBlur : 0);
    activeDuo?.setCoverBlur?.(releaseVfxEnabled ? frame.coverBlur : 0);
    keyLight.intensity = frame.lighting.keyIntensity;
    fillLight.intensity = frame.lighting.fillIntensity;
    applyFinishLighting();
    // A finite softbox produces a broad specular band across the native polished rails.
    // Its measured sweep belongs to Film 09; free inspection uses the normal studio lights.
    const macroProgress = THREE.MathUtils.clamp(frame.time / IPHONE_DUO_HINGE_CUT, 0, 1);
    macroLight.intensity = 0;
    macroLightReleaseActive = false;
    if (frame.sequence === 'hinge') {
      const pivot = activeDuo?.getParts?.().displayPivot;
      if (pivot) {
        const hinge = pivot.getWorldPosition(new THREE.Vector3());
        const targetY = hinge.y - 0.108 + 0.023 * macroProgress;
        // The pre-cut sweep follows the source macro. After the cut, hold the softbox above
        // the hinge so the side rail keeps a broad titanium highlight in the profile pose.
        const postCut = frame.time >= IPHONE_DUO_HINGE_CUT;
        const lightY = postCut ? targetY + 0.55 : targetY + 0.65 - 1.05 * macroProgress;
        macroLight.position.set(hinge.x, lightY, 4);
        macroLight.lookAt(hinge.x, macroLight.position.y, 0);
        macroLight.intensity = postCut
          ? weightedFinishValue(currentFinishWeights, (palette) => palette.lighting.macroPostCut)
          : 3 - 2.6 * macroProgress * macroProgress;
        macroLightReleaseActive = true;
      }
    }

    rimLight.intensity = releaseVfxEnabled ? frame.lighting.rimIntensity : 0;
    rimLight.position.set(2.2 + frame.lighting.sweep * 3.1, 5.5, -6 + frame.lighting.sweep * 2.4);
    if (applyCamera) {
      updateCameraAspect();
      let zoom = frame.camera.zoom;
      let cameraPosition = frame.camera.position;
      let cameraTarget = frame.camera.target;
      if (frame.sequence === 'hinge' && frame.time < IPHONE_DUO_HINGE_CUT) {
        // Film 09's macro stays end-on while the display leaf opens. Anchor both the camera
        // and its target to the measured moving-leaf pivot after applyModelState has recentered
        // the articulated pair. This keeps the hinge tip in place without introducing a camera
        // pitch as the V flattens. Fall back to the authored frame pose if the part is unavailable.
        const displayPivot = activeDuo?.getParts?.().displayPivot;
        if (displayPivot) {
          const hingeWorld = displayPivot.getWorldPosition(new THREE.Vector3());
          cameraPosition = [hingeWorld.x, hingeWorld.y - 0.108 + 0.023 * macroProgress, 7.2];
          cameraTarget = [hingeWorld.x, hingeWorld.y - 0.108 + 0.023 * macroProgress, 0];
        }
      }
      if (frame.sequence === 'hinge' && frame.time >= IPHONE_DUO_HINGE_CUT && activeRoot) {
        // Match source 09's approximately 72% profile width, then cap the target on narrow
        // stages so the whole native profile remains drawable instead of being cropped.
        const profileWidth = new THREE.Box3().setFromObject(activeRoot).getSize(new THREE.Vector3()).x;
        const baseFrustumWidth = baseCameraHalfWidth * 2 * (new THREE.Vector3(...cameraPosition).distanceTo(new THREE.Vector3(...cameraTarget)) / 8);
        if (profileWidth > 0.001) zoom = Math.min(zoom, (0.72 * baseFrustumWidth) / profileWidth) * 0.94;
        zoom = THREE.MathUtils.clamp(zoom, controls.minZoom, controls.maxZoom);
      }
      camera.position.set(...cameraPosition).sub(new THREE.Vector3(...cameraTarget)).multiplyScalar(2.5).add(new THREE.Vector3(...cameraTarget));
      controls.target.set(...cameraTarget);
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      controls.update();
    }
    syncCameraSideLighting();
  };

  const resetCanonicalCamera = (): void => {
    viewTransition = null;
    camera.position.copy(CAMERA_PRESETS.reset.position);
    controls.target.copy(CAMERA_PRESETS.reset.target);
    camera.zoom = 1;
    updateCameraAspect();
    camera.updateProjectionMatrix();
    controls.update();
  };

  const resetNativeInspectionPose = (): void => {
    macroLight.intensity = 0;
    macroLightReleaseActive = false;
    if (activeProvider !== 'articulated' || !activeRoot) return;
    activeRoot.rotation.set(0, 0, 0);
    applyModelState();
  };

  const pauseRelease = (): void => {
    if (!releasePlaying) return;
    releasePlaying = false;
    controls.enabled = !contextLost && !loading;
    announceAnimation(true);
  };

  const playRelease = (): void => {
    if (activeProvider !== 'articulated' || activeDuo?.capabilities?.fold !== true || loading || contextLost || document.hidden) return;
    // A manual restart may follow a suspended RAF interval; start the next delta from zero.
    lastRenderTime = 0;
    if (releaseTime >= releaseFrame.duration) {
      releaseTime = 0;
      viewTransition = null;
      applyReleaseFrame(sampleIphoneDuoRelease(releaseSequence, releaseTime));
    }
    releasePlaying = true;
    hasAutoPlayed = true;
    controls.enabled = false;
    announceAnimation(true);
  };

  const seekRelease = (rawTime: number): void => {
    pauseRelease();
    viewTransition = null;
    releaseTime = THREE.MathUtils.clamp(Number.isFinite(rawTime) ? rawTime : 0, 0, releaseFrame.duration);
    applyReleaseFrame(sampleIphoneDuoRelease(releaseSequence, releaseTime));
    announceAnimation();
  };

  const setReleaseSequence = (sequence: IphoneDuoReleaseSequence): void => {
    if (sequence !== 'display' && sequence !== 'hinge') return;
    pauseRelease();
    viewTransition = null;
    releaseSequence = sequence;
    releaseTime = 0;
    releaseFrame = sampleIphoneDuoRelease(sequence, 0);
    if (activeProvider === 'articulated') applyReleaseFrame(releaseFrame);
    announceAnimation(true);
  };

  const animateViewTo = (view: IphoneDuoView): void => {
    pauseRelease();
    viewTransition = null;
    resetNativeInspectionPose();
    controls.enabled = true;
    camera.zoom = 1;
    updateCameraAspect();
    camera.updateProjectionMatrix();
    const preset = CAMERA_PRESETS[view];
    const duration = reducedMotion ? 0 : 520;
    if (duration === 0) {
      camera.position.copy(preset.position);
      controls.target.copy(preset.target);
      controls.update();
      return;
    }
    viewTransition = {
      startedAt: performance.now(),
      duration,
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPosition: preset.position.clone(),
      toTarget: preset.target.clone(),
    };
  };

  const orbit = (deltaRadians: number): void => {
    if (!Number.isFinite(deltaRadians)) return;
    pauseRelease();
    viewTransition = null;
    controls.enabled = true;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += deltaRadians;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update();
  };

  const loadProvider = async (provider: IphoneDuoProvider, preserveCamera: boolean): Promise<void> => {
    macroLight.intensity = 0;
    macroLightReleaseActive = false;
    const token = ++loadToken;
    activeProvider = provider;
    loading = true;
    errorMessage = null;
    pauseRelease();
    if (provider !== 'articulated' && !preserveCamera) resetCanonicalCamera();
    disposeActiveRoot();
    options.onLoading?.(provider);
    announceState();
    try {
      let root: THREE.Group;
      if (provider === 'articulated') {
        root = await Promise.resolve(createIphoneDuoModel());
      } else {
        root = await loadEncodedIphoneDuoHyper3dSource();
      }
      if (disposed || token !== loadToken) {
        const staleDuo = provider === 'articulated' ? asDuoHandle(root) : null;
        if (staleDuo?.dispose) staleDuo.dispose();
        else disposeObjectGraph(root);
        return;
      }
      fitRootToStage(root, provider);
      activeRoot = root;
      activeDuo = provider === 'articulated' ? asDuoHandle(root) : null;
      if (provider === 'articulated' && !activeDuo) {
        throw new Error('The Apple reference model did not expose its measured hinge controls');
      }
      if (activeDuo?.capabilities?.fold === true) {
        if (!preserveCamera) currentFold = releaseFrame.fold;
      } else {
        targetFold = 0;
        currentFold = 0;
        foldTransition = null;
      }
      if (activeDuo?.capabilities?.finish !== true) {
        currentFinish = 'white';
        currentFinishWeights = createFinishWeights('white');
        currentFinishMix = currentFinishWeights.night;
        finishTransition = null;
        finishSweepLight.intensity = 0;
        applyFinishLighting();
      }
      scene.add(root);
      if (provider === 'articulated') {
        if (preserveCamera) {
          // Context restoration should reconstruct the currently inspected pose and screen
          // selection, rather than snapping back to the timeline's last sampled frame.
          applyModelState();
          activeDuo?.setDisplayBlur?.(releaseVfxEnabled ? releaseFrame.displayBlur : 0);
          activeDuo?.setCoverBlur?.(releaseVfxEnabled ? releaseFrame.coverBlur : 0);
          keyLight.intensity = releaseFrame.lighting.keyIntensity;
          fillLight.intensity = releaseFrame.lighting.fillIntensity;
          applyFinishLighting();
        } else {
          applyReleaseFrame(releaseFrame, true);
        }
      } else applyModelState();
      loading = false;
      errorMessage = null;
      controls.enabled = !releasePlaying && !contextLost;
      if (preserveCamera) {
        camera.position.copy(savedCameraPosition);
        controls.target.copy(savedCameraTarget);
        camera.zoom = savedCameraZoom;
        camera.updateProjectionMatrix();
        controls.update();
        restoringContext = false;
      }
      options.onReady?.(state());
      announceState();
      announceAnimation(true);
      if (!preserveCamera && provider === 'articulated' && stageVisible && !reducedMotion && !hasAutoPlayed) {
        playRelease();
      }
    } catch (loadError) {
      if (disposed || token !== loadToken) return;
      loading = false;
      disposeActiveRoot();
      const message = loadError instanceof Error ? loadError.message : `Unable to load the ${provider} study`;
      recordError(message);
    }
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    savedCameraPosition.copy(camera.position);
    savedCameraTarget.copy(controls.target);
    savedCameraZoom = camera.zoom;
    restoringContext = true;
    contextLost = true;
    pauseRelease();
    controls.enabled = false;
    recordError('The 3D context was interrupted. Restoring the study…');
  };

  const onContextRestored = (): void => {
    contextLost = false;
    rebuildEnvironment();
    void loadProvider(activeProvider, restoringContext);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      orbit(-0.24);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      orbit(0.24);
    } else if (event.key === 'Home' || event.key === 'Escape') {
      event.preventDefault();
      animateViewTo('reset');
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      animateViewTo('front');
    } else if (event.key.toLowerCase() === 'b') {
      event.preventDefault();
      animateViewTo('back');
    }
  };

  const onVisibilityChange = (): void => {
    // Browsers may suspend RAF while hidden. Rebase before the first visible frame so the hidden
    // interval cannot be consumed as release motion when playback resumes.
    lastRenderTime = 0;
    if (document.hidden) pauseRelease();
  };

  const onControlsStart = (): void => {
    pauseRelease();
  };

  const onStagePointerDown = (): void => {
    pauseRelease();
  };

  const onStageWheel = (): void => {
    pauseRelease();
  };

  const intersectionObserver = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver((entries) => {
        const entry = entries[0];
        stageVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0.2);
        if (!stageVisible) pauseRelease();
        if (stageVisible && !hasAutoPlayed && !reducedMotion && activeProvider === 'articulated' && activeRoot && !loading && !contextLost) {
          playRelease();
        }
      }, { threshold: [0, 0.2, 0.5] });

  const render = (now: number): void => {
    if (disposed) return;
    if (releasePlaying && activeProvider === 'articulated' && activeDuo?.capabilities?.fold === true) {
      // `releaseFrame.time` is a timeline value, so use a frame clock rather than the render
      // timestamp itself. This keeps seeking/replay deterministic and makes a paused frame inert.
      const delta = lastRenderTime > 0 ? Math.max(0, now - lastRenderTime) / 1000 : 0;
      releaseTime += delta;
      if (releaseTime >= releaseFrame.duration) {
        if (releaseLoop) {
          releaseTime %= releaseFrame.duration;
        } else {
          releaseTime = releaseFrame.duration;
          releasePlaying = false;
          controls.enabled = true;
        }
      }
      applyReleaseFrame(sampleIphoneDuoRelease(releaseSequence, releaseTime));
      announceAnimation();
    } else if (foldTransition && activeDuo && activeRoot) {
      const progress = THREE.MathUtils.clamp((now - foldTransition.startedAt) / foldTransition.duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      currentFold = THREE.MathUtils.lerp(foldTransition.from, foldTransition.to, eased);
      applyModelState();
      if (progress >= 1) {
        currentFold = foldTransition.to;
        foldTransition = null;
        announceState();
      }
    }
    sampleFinishTransition(now);
    if (!releasePlaying && viewTransition) {
      const progress = THREE.MathUtils.clamp((now - viewTransition.startedAt) / viewTransition.duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(viewTransition.fromPosition, viewTransition.toPosition, eased);
      controls.target.lerpVectors(viewTransition.fromTarget, viewTransition.toTarget, eased);
      controls.update();
      if (progress >= 1) viewTransition = null;
    } else {
      controls.update();
    }
    syncCameraSideLighting();
    renderer.render(scene, camera);
    lastRenderTime = now;
    animationFrame = window.requestAnimationFrame(render);
  };

  renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);
  options.container.addEventListener('keydown', onKeyDown);
  controls.addEventListener('start', onControlsStart);
  renderer.domElement.addEventListener('pointerdown', onStagePointerDown);
  renderer.domElement.addEventListener('wheel', onStageWheel, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  intersectionObserver?.observe(options.container);
  if (!intersectionObserver) stageVisible = true;
  resizeObserver.observe(options.container);
  rebuildEnvironment();
  resize();
  camera.position.copy(CAMERA_PRESETS.reset.position);
  controls.target.copy(CAMERA_PRESETS.reset.target);
  controls.update();
  animationFrame = window.requestAnimationFrame(render);
  void loadProvider('articulated', false);

  return {
    setFold(degrees: number): void {
      pauseRelease();
      if (activeDuo?.capabilities?.fold !== true) {
        targetFold = 0;
        currentFold = 0;
        foldTransition = null;
        applyModelState();
        announceState();
        return;
      }
      targetFold = clampFold(degrees);
      if (!activeRoot || reducedMotion) {
        currentFold = targetFold;
        foldTransition = null;
        applyModelState();
        announceState();
        return;
      }
      foldTransition = {
        startedAt: performance.now(),
        duration: 650,
        from: currentFold,
        to: targetFold,
      };
      announceState();
    },
    setFinish(finish: IphoneDuoFinish): void {
      if (activeDuo?.capabilities?.finish !== true) {
        currentFinish = 'white';
        currentFinishWeights = createFinishWeights('white');
        currentFinishMix = currentFinishWeights.night;
        finishTransition = null;
        finishSweepLight.intensity = 0;
        applyFinishLighting();
        applyModelState();
        announceState();
        return;
      }
      currentFinish = isIphoneDuoFinish(finish) ? finish : 'white';
      const targetWeights = createFinishWeights(currentFinish);
      const weightDelta = IPHONE_DUO_FINISHES.reduce(
        (sum, key) => sum + Math.abs(targetWeights[key] - currentFinishWeights[key]),
        0,
      );
      if (!activeRoot || reducedMotion || weightDelta < 1e-4) {
        finishTransition = null;
        finishSweepLight.intensity = 0;
        applyFinishWeights(targetWeights);
        applyModelState();
        announceState();
        return;
      }
      finishTransition = {
        startedAt: performance.now(),
        duration: 1200,
        from: { ...currentFinishWeights },
        to: targetWeights,
      };
      syncFinishState();
      announceState();
    },
    setScreen(screen: IphoneDuoScreen): void {
      currentScreen = isIphoneDuoScreen(screen) ? screen : 'desert';
      syncScreenState();
      announceState();
    },
    setProvider(provider: IphoneDuoProvider): Promise<void> {
      if (provider === activeProvider && activeRoot && !loading) return Promise.resolve();
      return loadProvider(provider, false);
    },
    setView(view: IphoneDuoView): void {
      animateViewTo(view);
      announceState();
    },
    orbit,
    resetView(): void {
      animateViewTo('reset');
      announceState();
    },
    setReducedMotion(value: boolean): void {
      reducedMotion = value;
      if (value) {
        pauseRelease();
        viewTransition = null;
        foldTransition = null;
        if (finishTransition) {
          const finishWeights = finishTransition.to;
          finishTransition = null;
          finishSweepLight.intensity = 0;
          applyFinishWeights(finishWeights);
          applyModelState();
        }
        controls.enabled = true;
      }
      announceState();
    },
    play(): void {
      playRelease();
    },
    pause(): void {
      pauseRelease();
    },
    replay(): void {
      pauseRelease();
      viewTransition = null;
      lastRenderTime = 0;
      releaseTime = 0;
      if (activeProvider === 'articulated') applyReleaseFrame(sampleIphoneDuoRelease(releaseSequence, 0));
      announceAnimation(true);
      playRelease();
    },
    seek(time: number): void {
      seekRelease(time);
    },
    setSequence(sequence: IphoneDuoReleaseSequence): void {
      setReleaseSequence(sequence);
    },
    setLoop(loop: boolean): void {
      releaseLoop = Boolean(loop);
      announceAnimation(true);
    },
    setVfx(enabled: boolean): void {
      releaseVfxEnabled = Boolean(enabled);
      if (activeProvider === 'articulated') applyReleaseFrame(releaseFrame, false);
      announceAnimation(true);
    },
    retry(): Promise<void> {
      return loadProvider(activeProvider, false);
    },
    inspect(): IphoneDuoSceneDiagnostics {
      const info = renderer.info.render;
      return {
        ...state(),
        finishMix: currentFinishMix,
        finishWeights: { ...currentFinishWeights },
        finishPalette: {
          label: IPHONE_DUO_FINISH_PALETTES[currentFinish].label,
          hex: IPHONE_DUO_FINISH_PALETTES[currentFinish].hex,
          study: IPHONE_DUO_FINISH_PALETTES[currentFinish].study,
        },
        finishTransitioning: finishTransition !== null,
        animation: animationState(),
        contextLost,
        renderer: {
          available: !contextLost,
          info: {
            triangles: info.triangles,
            calls: info.calls,
            points: info.points,
            lines: info.lines,
          },
          triangles: info.triangles,
          width: options.container.clientWidth,
          height: options.container.clientHeight,
          pixelRatio: renderer.getPixelRatio(),
        },
        errors: [...errors],
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAnimationAnnouncementTimer();
      loadToken += 1;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      options.container.removeEventListener('keydown', onKeyDown);
      controls.removeEventListener('start', onControlsStart);
      renderer.domElement.removeEventListener('pointerdown', onStagePointerDown);
      renderer.domElement.removeEventListener('wheel', onStageWheel);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      disposeActiveRoot();
      removeAndDisposeShadow(shadow);
      controls.dispose();
      environmentTarget?.dispose();
      pmrem?.dispose();
      fillLight.shadow.map?.dispose();
      fillLight.shadow.map = null;
      scene.environment = null;
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function createUnavailableController(options: IphoneDuoSceneOptions, reason: string): IphoneDuoSceneController {
  options.onStateChange?.({
    fold: 0,
    finish: 'white',
    screen: 'desert',
    provider: 'articulated',
    ready: false,
    articulated: false,
    loading: false,
    error: reason,
  });
  let fold = 0;
  let finish: IphoneDuoFinish = 'white';
  let screen: IphoneDuoScreen = 'desert';
  let provider: IphoneDuoProvider = 'articulated';
  let error = reason;
  let sequence: IphoneDuoReleaseSequence = 'display';
  let time = 0;
  let loop = false;
  let vfxEnabled = true;
  const animation = (): IphoneDuoAnimationState => ({
    sequence,
    time,
    duration: IPHONE_DUO_RELEASE_DURATIONS[sequence],
    playing: false,
    loop,
    vfxEnabled,
  });
  const diagnostics = (): IphoneDuoSceneDiagnostics => ({
    fold,
    finish,
    screen,
    provider,
    ready: false,
    articulated: false,
    loading: false,
    error,
    finishMix: 0,
    finishWeights: createFinishWeights('white'),
    finishPalette: {
      label: IPHONE_DUO_FINISH_PALETTES.white.label,
      hex: IPHONE_DUO_FINISH_PALETTES.white.hex,
      study: IPHONE_DUO_FINISH_PALETTES.white.study,
    },
    finishTransitioning: false,
    animation: animation(),
    contextLost: false,
    renderer: {
      available: false,
      info: { triangles: 0, calls: 0, points: 0, lines: 0 },
      triangles: 0,
      width: 0,
      height: 0,
      pixelRatio: 1,
    },
    errors: [reason],
  });
  return {
    setFold: (value) => { fold = clampFold(value); },
    setFinish: (value) => { finish = value; },
    setScreen: (value) => { screen = isIphoneDuoScreen(value) ? value : 'desert'; },
    setProvider: async (value) => { provider = value; },
    setView: () => undefined,
    orbit: () => undefined,
    resetView: () => undefined,
    setReducedMotion: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    replay: () => { time = 0; },
    seek: (value) => { time = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, IPHONE_DUO_RELEASE_DURATIONS[sequence]); },
    setSequence: (value) => { if (value === 'display' || value === 'hinge') { sequence = value; time = 0; } },
    setLoop: (value) => { loop = Boolean(value); },
    setVfx: (value) => { vfxEnabled = Boolean(value); },
    retry: async () => { error = reason; options.onError?.(reason); },
    inspect: diagnostics,
    dispose: () => undefined,
  };
}
