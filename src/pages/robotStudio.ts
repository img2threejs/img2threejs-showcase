import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { DemoEntry } from '../demos/registry';
import {
  applyRobotAnimationCorrection,
  resetRobotAnimationCorrection,
  createRobotModel,
  disposeRobotModel,
  resetRobotSegmentColor,
  robotSegmentColor,
  robotSegmentForFace,
  setRobotSegmentColor,
  waitForRobotModel,
  type RobotRuntime,
} from '../demos/man-robot-studio/robotModel';
import type { RobotPaintTarget, RobotSegmentId } from '../demos/man-robot-studio/robotModel';
import { getRobotAnimationProfile } from '../demos/man-robot-studio/animationProfile';
import {
  createRobotStreetControls,
  ROBOT_STREET_SKILLS,
  type RobotStreetControls,
} from '../demos/man-robot-studio/streetControls';
import { createRobotStreetEnvironment } from '../demos/man-robot-studio/streetEnvironment';
import '../demos/man-robot-studio/robotStudio.css';

/** Fallback navigation anchor used before the street controller exists. */
const STREET_ORIGIN = new THREE.Vector3(0, 0, 0);
/** Measured to frame native kicks and greetings across eight navigation headings. */
const STREET_CAMERA_OFFSET = new THREE.Vector3(0, 2.203, 4.131);

/** Cross-fade length used when the host swaps one native clip for another. */
const ACTION_CROSSFADE = 0.25;
/** Cross-fade length used when the robot returns to the shared Gongshou rest pose. */
const REST_CROSSFADE = 0.35;

const STUDIO_MARKUP = [
  '<main class="robot-studio" aria-label="Man robot segment color studio">',
  '  <header class="robot-topbar">',
  '    <a class="robot-back" href="#/" aria-label="Back to showcase gallery"><span aria-hidden="true">←</span><span>Gallery</span></a>',
  '    <div class="robot-wordmark"><span class="robot-mark">3D</span><span>IMG2THREEJS <i>/</i> SHOWCASE</span></div>',
  '    <div class="robot-header-state" id="robot-header-state"><span class="robot-state-dot"></span><span>Loading source surface</span></div>',
  '  </header>',
  '  <div class="robot-layout">',
  '    <section class="robot-stage" id="robot-stage" aria-label="Interactive robot model">',
  '      <div class="robot-stage-top"><span class="robot-stage-index">STUDY 01 <i>/</i> 01</span><span class="robot-source-pill"><span class="robot-source-dot"></span> SOURCE MESH ACTIVE</span></div>',
  '      <div class="robot-canvas-mount" id="robot-canvas"></div>',
  '      <div class="robot-loading" id="robot-loading" role="status" aria-live="polite">',
  '        <span class="robot-loader-ring" aria-hidden="true"></span>',
  '        <div><strong id="robot-loading-title">Reading the source surface</strong><span id="robot-loading-copy">Loading the original mesh, materials and motion clips.</span></div>',
  '        <span class="robot-progress-track"><span id="robot-progress-fill"></span></span>',
  '      </div>',
  '      <div class="robot-floating-picker" id="robot-floating-picker" hidden>',
  '        <input id="robot-floating-color" type="color" value="#f4f4f2" aria-label="Choose color for selected robot segment" />',
  '        <span>COLOR</span>',
  '      </div>',
  '      <div class="robot-view-tools">',
  '        <button class="robot-view-button" id="robot-rotate" type="button" aria-pressed="false" title="Start slow turntable rotation"><span aria-hidden="true">↻</span><span class="robot-view-label">Rotate</span></button>',
  '        <button class="robot-view-button" id="robot-reset-view" type="button" title="Reset camera view"><span aria-hidden="true">⌖</span><span class="robot-view-label">Reset view</span></button>',
  '      </div>',
  '      <div class="robot-stage-caption"><span>DRAG TO ORBIT <i>·</i> SCROLL TO ZOOM</span><span id="robot-stage-caption-right">ARROWS MOVE · 1–9 SKILLS</span></div>',
  '    </section>',
  '    <aside class="robot-console" aria-label="Robot segment and animation controls">',
  '      <div class="robot-console-head"><div><span class="robot-eyebrow">COMPONENT EDITOR</span><h1 id="robot-demo-title">MAN ROBOT</h1></div><span class="robot-version">01</span></div>',
  "      <p class=\"robot-intro\">Choose a body segment or click the model. Each vertex belongs to one dominant part; tint and reset stay within that part.</p>",
  "      <div class=\"robot-stats\" id=\"robot-stats\"><div><strong id=\"robot-mesh-count\">—</strong><span>SKINNED MESH</span></div><div><strong id=\"robot-joint-count\">—</strong><span>JOINTS</span></div><div><strong id=\"robot-clip-count\">—</strong><span>CLIPS</span></div></div>",
  "      <section class=\"robot-section\" aria-labelledby=\"robot-segments-title\">",
  "        <div class=\"robot-section-heading\"><h2 id=\"robot-segments-title\">Segments</h2><span id=\"robot-segment-total\">0 vertices mapped</span></div>",
  "        <div class=\"robot-segment-list\" id=\"robot-segment-list\"></div>",
  "      </section>",
  "      <section class=\"robot-selected-card\" id=\"robot-selected-card\" hidden aria-labelledby=\"robot-selected-name\">",
  "        <div class=\"robot-selected-heading\"><div><span class=\"robot-eyebrow\">ACTIVE SEGMENT</span><h2 id=\"robot-selected-name\">—</h2></div><button class=\"robot-clear-selection\" id=\"robot-clear-selection\" type=\"button\" aria-label=\"Clear selected part\">×</button></div>",
  "        <p class=\"robot-selected-meta\" id=\"robot-selected-meta\">Select a skinned surface to begin.</p>",
  "        <div class=\"robot-color-row\"><div><span class=\"robot-eyebrow\">SEGMENT COLOR</span><span class=\"robot-color-value\" id=\"robot-color-value\">Original</span></div><input class=\"robot-color-orb\" id=\"robot-panel-color\" type=\"color\" value=\"#f4f4f2\" aria-label=\"Choose color for active segment\" /></div>",
  "        <button class=\"robot-reset-segment\" id=\"robot-reset-segment\" type=\"button\">Restore source color</button>",
  "      </section>",
  "      <section class=\"robot-section robot-street-section\" aria-labelledby=\"robot-street-title\">",
  "        <div class=\"robot-section-heading\"><h2 id=\"robot-street-title\">Street controls</h2><output class=\"robot-animation-status\" id=\"robot-street-status\" aria-live=\"polite\">Load the source to move</output></div>",
  "        <div class=\"robot-street-help\"><span class=\"robot-street-keys\" aria-hidden=\"true\"><kbd>&#8593;</kbd><kbd>&#8592;</kbd><kbd>&#8595;</kbd><kbd>&#8594;</kbd></span><span class=\"robot-street-help-text\">Arrow keys walk the street; hold <kbd>Shift</kbd> with a direction to run. Release the direction to stop. Keys <kbd>1</kbd> to <kbd>9</kbd> play the nine street skills once.</span></div>",
  "        <div class=\"robot-skill-grid\" id=\"robot-skill-list\"></div>",
  "      </section>",
  "      <section class=\"robot-section robot-animation-section\" aria-labelledby=\"robot-animation-title\">",
  "        <div class=\"robot-section-heading\"><h2 id=\"robot-animation-title\">Motion library</h2><output class=\"robot-animation-status\" id=\"robot-animation-status\" aria-live=\"polite\">Ready when loaded</output></div>",
  "        <div class=\"robot-clip-list\" id=\"robot-clip-list\"></div>",
  "        <div class=\"robot-playback-row\"><button id=\"robot-play-pause\" type=\"button\" disabled><span aria-hidden=\"true\">▶</span><span>Play</span></button><button id=\"robot-stop-animation\" type=\"button\" disabled>Stop / reset</button></div>",
  "      </section>",
  "      <div class=\"robot-console-footer\"><button class=\"robot-reset-all\" id=\"robot-reset-all\" type=\"button\" disabled>Restore all source colors</button><a id=\"robot-source-link\" href=\"#\" target=\"_blank\" rel=\"noopener noreferrer\">View implementation <span aria-hidden=\"true\">↗</span></a></div>",
  "      <p class=\"robot-animation-warning\" role=\"note\">One-shot clips return to the shared Gongshou rest pose after they complete; Stop / reset returns there immediately.</p>",
  "      <p class=\"robot-provenance\">Original positions, normals, UVs and texture map stay intact; per-segment tints use a runtime vertex-color layer.</p>",
  '    </aside>',
  '  </div>',
  '</main>',
].join('');

interface RobotStudioDebug {
  ready: boolean;
  meshCount: number;
  vertexCount: number;
  jointCount: number;
  triangleCount: number;
  clips: Array<{ name: string; duration: number; tracks: number }>;
  segments: Array<{ id: string; label: string; meshCount: number; vertexCount: number; center: number[] }>;
  auditClips: () => Array<{ name: string; tracks: number; duration: number; movingBones: number; maxPositionDelta: number; maxRotationDelta: number }>;
  /** Live street controller state; null until the native model finished loading. */
  street: () => RobotStreetDebugState | null;
}

/** Diagnostic snapshot of the live street controller, mirroring RobotStreetControls.getState(). */
export interface RobotStreetDebugState {
  position: number[];
  moving: boolean;
  clip: string | null;
  heldKeys: string[];
  /** Name of the clip the host currently plays, or null while the robot rests. */
  activeClip: string | null;
  /** True while the asset export holds the animation frozen. */
  exportFrozen: boolean;
}

/** Locked runtime handles the studio page exposes to its host (capture snapshot, current state, edit gate). */
export interface RobotStudioExportContext {
  mount: HTMLElement;
  demo: DemoEntry;
  /** Returns the live model group + animation runtime once it is loaded; null until then. */
  getRuntime: () => { displayRoot: THREE.Group; runtime: RobotRuntime } | null;
  /** True after the host marks the route disposed; safe to call from any awaited continuation. */
  isDisposed: () => boolean;
  /**
   * Drive the studio's edit/asset-busy gate. The page freezes the clock + skips the next mixer
   * update; the handler must invoke the exporter between setAssetBusy(true) and setAssetBusy(false)
   * in a try/finally. The page does not touch any activeAction, mixer, finished flag, or weight, so
   * the live pose and crossfade survive a busy release unchanged.
   */
  setAssetBusy: (busy: boolean) => void;
}

/** Host-supplied handler called once the studio is mounted. The returned object drives section readiness. */
export interface RobotStudioExportHandler {
  ready: () => void;
  dispose: () => void;
}

export interface RobotStudioOptions {
  /**
   * Inject an export panel after the page has built. The page only exposes the runtime; the host
   * is responsible for the import tree (exporters, source-download) so the source archive can
   * opt out of those dependencies and ship the studio without GLTFLoader.
   */
  mountExports?: (context: RobotStudioExportContext) => RobotStudioExportHandler;
}

function labelForClip(name: string, index: number): string {
  return name ? name.replace(/_/g, ' ') : 'Animation ' + (index + 1);
}

function collectPose(root: THREE.Object3D): Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }> {
  const pose: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }> = [];
  root.traverse((object) => {
    if (!(object as THREE.Bone).isBone) return;
    pose.push({ position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() });
  });
  return pose;
}

function auditClip(runtime: RobotRuntime, clip: THREE.AnimationClip): { movingBones: number; maxPositionDelta: number; maxRotationDelta: number } {
  const auditRoot = cloneSkeleton(runtime.model) as THREE.Group;
  const mixer = new THREE.AnimationMixer(auditRoot);
  const action = mixer.clipAction(clip);
  action.reset().play();
  mixer.setTime(0);
  auditRoot.updateMatrixWorld(true);
  const start = collectPose(auditRoot);
  mixer.setTime(Math.max(clip.duration * 0.5, 1 / 60));
  auditRoot.updateMatrixWorld(true);
  const middle = collectPose(auditRoot);
  let movingBones = 0;
  let maxPositionDelta = 0;
  let maxRotationDelta = 0;
  for (let index = 0; index < Math.min(start.length, middle.length); index++) {
    const positionDelta = start[index].position.distanceTo(middle[index].position);
    const rotationDelta = start[index].quaternion.angleTo(middle[index].quaternion);
    const scaleDelta = start[index].scale.distanceTo(middle[index].scale);
    maxPositionDelta = Math.max(maxPositionDelta, positionDelta);
    maxRotationDelta = Math.max(maxRotationDelta, rotationDelta);
    if (positionDelta > 1e-6 || rotationDelta > 1e-6 || scaleDelta > 1e-6) movingBones++;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(auditRoot);
  return { movingBones, maxPositionDelta, maxRotationDelta };
}

export function renderRobotStudio(
  mount: HTMLElement,
  demo: DemoEntry,
  options: RobotStudioOptions = {},
): () => void {
  mount.innerHTML = STUDIO_MARKUP;
  const query = <T extends Element>(selector: string): T => {
    const element = mount.querySelector<T>(selector);
    if (!element) throw new Error('Robot studio is missing ' + selector + '.');
    return element;
  };
  const stage = query<HTMLElement>('#robot-stage');
  const canvasMount = query<HTMLDivElement>('#robot-canvas');
  const loading = query<HTMLElement>('#robot-loading');
  const loadingTitle = query<HTMLElement>('#robot-loading-title');
  const loadingCopy = query<HTMLElement>('#robot-loading-copy');
  const progressFill = query<HTMLElement>('#robot-progress-fill');
  const headerState = query<HTMLElement>('#robot-header-state');
  const segmentList = query<HTMLDivElement>('#robot-segment-list');
  const clipList = query<HTMLDivElement>('#robot-clip-list');
  const selectedCard = query<HTMLElement>('#robot-selected-card');
  const selectedName = query<HTMLElement>('#robot-selected-name');
  const selectedMeta = query<HTMLElement>('#robot-selected-meta');
  const colorValue = query<HTMLElement>('#robot-color-value');
  const panelColor = query<HTMLInputElement>('#robot-panel-color');
  const floatingPicker = query<HTMLElement>('#robot-floating-picker');
  const floatingColor = query<HTMLInputElement>('#robot-floating-color');
  const animationStatus = query<HTMLOutputElement>('#robot-animation-status');
  const streetStatus = query<HTMLOutputElement>('#robot-street-status');
  const skillList = query<HTMLDivElement>('#robot-skill-list');
  const playPauseButton = query<HTMLButtonElement>('#robot-play-pause');
  const stopButton = query<HTMLButtonElement>('#robot-stop-animation');
  const resetSegmentButton = query<HTMLButtonElement>('#robot-reset-segment');
  const resetAllButton = query<HTMLButtonElement>('#robot-reset-all');
  const rotateButton = query<HTMLButtonElement>('#robot-rotate');
  const resetViewButton = query<HTMLButtonElement>('#robot-reset-view');
  const meshCount = query<HTMLElement>('#robot-mesh-count');
  const jointCount = query<HTMLElement>('#robot-joint-count');
  const clipCount = query<HTMLElement>('#robot-clip-count');
  const segmentTotal = query<HTMLElement>('#robot-segment-total');
  const sourceLink = query<HTMLAnchorElement>('#robot-source-link');
  query<HTMLElement>('#robot-demo-title').textContent = demo.title;
  sourceLink.href = demo.sourceUrl;
  sourceLink.title = demo.sourcePath;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(47, 1, 0.05, 350);
  camera.position.copy(STREET_CAMERA_OFFSET);
  const renderer = new WebGPURenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  // The built-in library keys by constructor.name, which production minification can rename.
  const materialLibrary = renderer.nodes.library;
  if (!materialLibrary.getMaterialNodeClass('MeshStandardMaterial')) {
    materialLibrary.addType(THREE.MeshStandardNodeMaterial, 'MeshStandardMaterial', materialLibrary.materialNodes);
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.domElement.setAttribute('aria-label', 'Robot on a street. Arrow keys move; keys 1 to 9 play skills. Drag to orbit and click a surface to select its segment.');
  renderer.domElement.tabIndex = 0;
  renderer.domElement.className = 'robot-renderer-canvas';
  canvasMount.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.03, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 2.4;
  controls.maxDistance = 7.2;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.update();

  // The accepted street world replaces the old studio hemisphere/key/rim/fill rig and its shadow
  // floor: one environment owns the sky, fog, sun and pavement, so lighting is never doubled.
  const streetEnvironment = createRobotStreetEnvironment(scene);

  let disposed = false;
  let rendererReady = false;
  let rendererDisposed = false;
  let rendererFailureMessage: string | null = null;
  const disposeRenderer = (): void => {
    if (rendererDisposed) return;
    rendererDisposed = true;
    renderer.dispose();
  };
  let frame = 0;
  let runtime: RobotRuntime | null = null;
  let displayRoot: THREE.Group | null = null;
  let activeSegment: RobotSegmentId | null = null;
  let activeAction: THREE.AnimationAction | null = null;
  let activeClipIndex: number | null = null;
  // Rest and the reusable captured-pose bridge never enter the native clip library.
  let restAction: THREE.AnimationAction | null = null;
  let poseBridgeAction: THREE.AnimationAction | null = null;
  const poseBridgeBones: Array<{
    bone: THREE.Bone;
    position: Float32Array;
    quaternion: Float32Array;
    scale: Float32Array;
    rawPosition: THREE.Vector3;
    rawQuaternion: THREE.Quaternion;
  }> = [];
  let clipFinished = false;
  let pendingRestTransition = false;
  let pointerStart: { x: number; y: number } | null = null;
  const rowButtons = new Map<RobotSegmentId, HTMLButtonElement>();
  const clipButtons: HTMLButtonElement[] = [];
  const skillButtons: HTMLButtonElement[] = [];
  // Native clip name behind each of the nine street skills, resolved once the model is loaded.
  const skillClipNames: string[] = [];
  // Runtime clip index behind each of the nine street skills; the controller resolves the same
  // prefixes, so the buttons and the keyboard always play the identical native clip.
  const skillClipIndices: number[] = [];
  // The street controller is created once the native model finished loading; it owns the
  // arrow-key walk/run state, the grounded-sole navigation and the camera follow.
  let streetControls: RobotStreetControls | null = null;
  let elapsed = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = new THREE.Clock();
  const marker = new THREE.Vector3();
  const canonicalRobotInverse = new THREE.Matrix4();
  let rotationOn = false;
  let exportAnimationFrozen = false;
  // Capture the pre-freeze disabled state of every studio control so the busy gate can
  // restore the exact previous enablement without recreating or re-binding animation actions.
  let exportControlSnapshot: {
    controlsEnabled: boolean;
    panelColor: boolean;
    floatingColor: boolean;
    resetSegmentButton: boolean;
    resetAllButton: boolean;
    playPauseButton: boolean;
    stopButton: boolean;
    rotateButton: boolean;
    resetViewButton: boolean;
    clipButtons: Map<HTMLButtonElement, boolean>;
    skillButtons: Map<HTMLButtonElement, boolean>;
    rowButtons: Map<HTMLButtonElement, boolean>;
  } | null = null;

  const resize = (): void => {
    const width = Math.max(1, canvasMount.clientWidth);
    const height = Math.max(1, canvasMount.clientHeight);
    if (rendererReady) renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvasMount);
  resize();

  const renderFrame = (): void => {
    if (disposed || !rendererReady) return;
    frame = requestAnimationFrame(renderFrame);
    if (exportAnimationFrozen) {
      // The asset export captures the live pose; advance no animation and paint no new frame.
      // Skipping controls.update too prevents the camera from drifting under the disabled mouse.
      return;
    }
    const delta = Math.min(clock.getDelta(), 0.1);
    elapsed += delta;
    if (runtime) {
      // The controller prepares the navigation anchor before the native mixer runs, so the
      // source clip and its runtime correction keep their own coordinate frame.
      streetControls?.beforeAnimation(delta);
      resetRobotAnimationCorrection(runtime);
      // Pausing the destination also freezes the bridge time and mixer-clock fades.
      runtime.mixer.update(activeAction?.paused ? 0 : delta);
      if (activeAction) {
        const correctionWeight = THREE.MathUtils.clamp(activeAction.getEffectiveWeight(), 0, 1);
        if (correctionWeight > 0) {
          if (correctionWeight < 1) {
            for (const pose of poseBridgeBones) {
              pose.rawPosition.copy(pose.bone.position);
              pose.rawQuaternion.copy(pose.bone.quaternion);
            }
          }
          applyRobotAnimationCorrection(runtime, activeAction.getClip().name, activeAction.time);
          if (correctionWeight < 1) {
            // The bridge already contains the outgoing correction. Introduce only the
            // destination's share instead of applying its full correction at zero weight.
            for (const pose of poseBridgeBones) {
              pose.bone.position.lerpVectors(pose.rawPosition, pose.bone.position, correctionWeight);
              pose.bone.quaternion.slerp(pose.rawQuaternion, 1 - correctionWeight);
            }
          }
        }
      }
      if (pendingRestTransition && activeAction) {
        pendingRestTransition = false;
        // The one-shot clip ended: fade into the shared Gongshou rest pose and let the street
        // controller resume any held arrows.
        fadeToRest();
      }
      runtime.displayRoot.updateMatrixWorld(true);
      // The controller samples the corrected soles, grounds them and moves the actor plus the
      // camera follow after the native pose is final.
      streetControls?.afterAnimation(delta);
    }
    streetEnvironment.update(elapsed, camera, streetControls?.position ?? STREET_ORIGIN);
    controls.update();
    renderer.render(scene, camera);
  };

  const setHeaderState = (text: string, state: 'loading' | 'ready' | 'error'): void => {
    headerState.dataset.state = state;
    const statusText = headerState.querySelector('span:last-child');
    if (statusText) statusText.textContent = text;
  };
  const showRendererFailure = (error: unknown): void => {
    rendererFailureMessage = error instanceof Error ? error.message : 'WebGPU and WebGL2 could not initialize.';
    loading.hidden = false;
    loading.classList.remove('is-complete');
    loading.classList.add('is-error');
    loadingTitle.textContent = '3D renderer unavailable';
    loadingCopy.textContent = rendererFailureMessage;
    setHeaderState('Renderer unavailable', 'error');
  };
  void renderer.init().then(() => {
    if (disposed) {
      disposeRenderer();
      return;
    }
    rendererReady = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.domElement.dataset.rendererBackend = renderer.backend.constructor.name;
    resize();
    frame = requestAnimationFrame(renderFrame);
  }).catch((error: unknown) => {
    disposeRenderer();
    if (disposed) return;
    showRendererFailure(error);
    console.error('Robot showcase renderer failed:', error);
  });

  const segmentColor = (segment: RobotPaintTarget): string => robotSegmentColor(segment);
  const syncSegmentRows = (): void => {
    if (!runtime) return;
    for (const [id, button] of rowButtons) {
      const segment = runtime.segments.get(id);
      if (!segment) continue;
      const active = id === activeSegment;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      const swatch = button.querySelector<HTMLElement>('.robot-segment-swatch');
      if (swatch) swatch.style.backgroundColor = segmentColor(segment);
      const count = button.querySelector<HTMLElement>('.robot-segment-count');
      if (count) count.textContent = segment.vertexCount >= 1000 ? (segment.vertexCount / 1000).toFixed(1) + 'k' : String(segment.vertexCount);
      button.disabled = segment.vertexCount === 0;
      button.classList.toggle('is-empty', segment.vertexCount === 0);
    }
  };

  const syncColorInputs = (): void => {
    if (!runtime || !activeSegment) return;
    const segment = runtime.segments.get(activeSegment);
    if (!segment) return;
    const value = segmentColor(segment);
    panelColor.value = value;
    floatingColor.value = value;
    colorValue.textContent = segment.tint ? value.toUpperCase() : 'Source color';
    const name = runtime.segments.get(activeSegment)?.label ?? 'Segment';
    panelColor.setAttribute('aria-label', 'Choose color for ' + name);
    floatingColor.setAttribute('aria-label', 'Choose color for ' + name);
    syncSegmentRows();
  };

  const placeFloatingPicker = (x: number, y: number): void => {
    const rect = stage.getBoundingClientRect();
    const left = Math.max(18, Math.min(rect.width - 78, x - rect.left + 20));
    const top = Math.max(62, Math.min(rect.height - 84, y - rect.top - 22));
    floatingPicker.style.left = left + 'px';
    floatingPicker.style.top = top + 'px';
    floatingPicker.hidden = false;
  };

  const placeFloatingPickerAtPoint = (point: THREE.Vector3): void => {
    if (!runtime) return;
    runtime.model.updateMatrixWorld(true);
    marker.copy(point).applyMatrix4(canonicalRobotInverse).applyMatrix4(runtime.displayRoot.matrixWorld).project(camera);
    const rect = stage.getBoundingClientRect();
    const x = rect.left + (marker.x + 1) * 0.5 * rect.width;
    const y = rect.top + (-marker.y + 1) * 0.5 * rect.height;
    placeFloatingPicker(x, y);
  };

  const selectMesh = (
    mesh: THREE.SkinnedMesh | null,
    segmentId: RobotSegmentId | null,
    x?: number,
    y?: number,
  ): void => {
    if (!runtime || exportAnimationFrozen) return;
    activeSegment = mesh ? segmentId : null;
    const segment = activeSegment ? runtime.segments.get(activeSegment) : undefined;
    if (!mesh || !segment) {
      selectedCard.hidden = true;
      floatingPicker.hidden = true;
      activeSegment = null;
      syncSegmentRows();
      return;
    }
    selectedCard.hidden = false;
    selectedName.textContent = segment.label;
    selectedMeta.textContent = segment.vertexCount.toLocaleString() + ' skin-weighted vertices';
    syncColorInputs();
    if (typeof x === 'number' && typeof y === 'number') placeFloatingPicker(x, y);
    else placeFloatingPickerAtPoint(segment.center);
    const status = query<HTMLElement>('#robot-stage-caption-right');
    status.textContent = 'SELECTED · ' + segment.label.toUpperCase();
  };

  const selectSegment = (segmentId: RobotSegmentId): void => {
    if (!runtime) return;
    const segment = runtime.segments.get(segmentId);
    const mesh = segment?.meshes[0];
    if (segment && mesh) selectMesh(mesh, segmentId);
  };

  const clearSelection = (): void => {
    selectMesh(null, null);
    query<HTMLElement>('#robot-stage-caption-right').textContent = 'ARROWS MOVE · 1–9 SKILLS';
  };

  const pickAt = (event: PointerEvent): { mesh: THREE.SkinnedMesh; segmentId: RobotSegmentId } | null => {
    if (!runtime) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(runtime.meshes, false).find((entry) => entry.object.visible);
    if (!hit?.face) return null;
    const mesh = hit.object as THREE.SkinnedMesh;
    const segmentId = robotSegmentForFace(runtime, mesh, hit.face);
    return segmentId ? { mesh, segmentId } : null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    pointerStart = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent): void => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const hit = pickAt(event);
    if (hit) selectMesh(hit.mesh, hit.segmentId, event.clientX, event.clientY);
    else clearSelection();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (pointerStart) return;
    renderer.domElement.style.cursor = pickAt(event) ? 'pointer' : 'grab';
  };
  const onPointerLeave = (): void => {
    if (!pointerStart) renderer.domElement.style.cursor = 'grab';
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  const applyColor = (input: HTMLInputElement): void => {
    if (!runtime || !activeSegment || exportAnimationFrozen) return;
    setRobotSegmentColor(runtime, activeSegment, input.value);
    syncColorInputs();
    const segment = runtime.segments.get(activeSegment);
    if (segment) colorValue.textContent = input.value.toUpperCase();
  };
  panelColor.addEventListener('input', () => applyColor(panelColor));
  floatingColor.addEventListener('input', () => applyColor(floatingColor));
  resetSegmentButton.addEventListener('click', () => {
    if (!runtime || !activeSegment) return;
    resetRobotSegmentColor(runtime, activeSegment);
    syncColorInputs();
  });
  query<HTMLButtonElement>('#robot-reset-all').addEventListener('click', () => {
    if (!runtime) return;
    for (const segment of runtime.segments.values()) resetRobotSegmentColor(runtime, segment.id);
    syncColorInputs();
    query<HTMLElement>('#robot-loading-copy').textContent = 'Every segment is back on its original source material color.';
  });
  query<HTMLButtonElement>('#robot-clear-selection').addEventListener('click', clearSelection);

  const setPlaybackButtons = (): void => {
    const isPlaying = !!activeAction && !activeAction.paused && !clipFinished;
    playPauseButton.setAttribute('aria-pressed', String(isPlaying));
    const label = playPauseButton.querySelector('span:last-child');
    if (label) label.textContent = isPlaying ? 'Pause' : 'Play';
    const icon = playPauseButton.querySelector('span:first-child');
    if (icon) icon.textContent = isPlaying ? 'Ⅱ' : '▶';
  };

  /** Mirrors the active native clip onto the nine street skill buttons. */
  const syncSkillButtons = (): void => {
    const activeName = activeAction && !clipFinished ? activeAction.getClip().name : null;
    for (let slot = 0; slot < skillButtons.length; slot++) {
      const button = skillButtons[slot];
      if (!activeName || slot >= skillClipNames.length) {
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
        continue;
      }
      const selected = activeName === skillClipNames[slot];
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  };

  /** Reports the live street state in the section header; called on state changes only. */
  const syncStreetStatus = (): void => {
    if (!streetControls) {
      streetStatus.value = 'Load the source to move';
      return;
    }
    const state = streetControls.getState();
    if (state.moving) {
      streetStatus.value = state.clip === 'run.001' ? 'Running the street' : 'Walking the street';
      return;
    }
    if (state.clip) {
      streetStatus.value = 'Playing · ' + (getRobotAnimationProfile(state.clip)?.label ?? state.clip);
      return;
    }
    streetStatus.value = 'Arrows walk · Shift runs · 1-9 skills';
  };

  const onAnimationFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== activeAction) return;
    clipFinished = true;
    pendingRestTransition = true;
    const clip = event.action.getClip();
    const profile = getRobotAnimationProfile(clip.name);
    animationStatus.value = 'Completed · ' + (profile?.label ?? labelForClip(clip.name, activeClipIndex ?? 0));
    // The one-shot clip is over: release the street controller, so held arrows walk again on
    // the next frame. The host fades into the rest pose itself.
    streetControls?.finishPlayback();
    setPlaybackButtons();
  };

  /** Reuses one local-bone pose, rather than restarting any interrupted outgoing fade. */
  const transitionFromDisplayedPose = (destination: THREE.AnimationAction, duration: number): void => {
    if (!runtime || !poseBridgeAction) return;
    // Capture before clearing correction bookkeeping or stopping actions: both restore
    // earlier poses, whereas the bridge must contain exactly what was last displayed.
    for (const pose of poseBridgeBones) {
      pose.bone.position.toArray(pose.position, 0);
      pose.bone.position.toArray(pose.position, 3);
      pose.bone.quaternion.toArray(pose.quaternion, 0);
      pose.bone.quaternion.toArray(pose.quaternion, 4);
      pose.bone.scale.toArray(pose.scale, 0);
      pose.bone.scale.toArray(pose.scale, 3);
    }
    resetRobotAnimationCorrection(runtime);
    runtime.mixer.stopAllAction();
    runtime.mixer.timeScale = 1;
    destination.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    if (duration > 0) {
      poseBridgeAction.reset()
        .setLoop(THREE.LoopRepeat, Infinity)
        .setEffectiveWeight(1)
        .setEffectiveTimeScale(1)
        .play()
        .fadeOut(duration);
      destination.fadeIn(duration);
    }
    destination.play();
    // stopAllAction restores saved binding values. Evaluate now, including when the
    // deferred rest transition runs after the frame's mixer update, so none can leak.
    runtime.mixer.update(0);
  };

  const playClip = (index: number, mode?: 'once' | 'loop'): void => {
    if (!runtime || !runtime.clips[index]) return;
    // The asset export captures the live pose; no clip may start while the frame is frozen.
    if (exportAnimationFrozen) return;
    const clip = runtime.clips[index];
    const profile = getRobotAnimationProfile(clip.name);
    if (!profile) throw new Error('Clip ' + clip.name + ' has no measured playback mode.');
    // Street locomotion loops; a numbered skill overrides even a looping source profile.
    const loops = mode ? mode === 'loop' : profile.loop;
    const action = runtime.mixer.clipAction(clip, runtime.model);
    action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, loops ? Infinity : 1);
    action.clampWhenFinished = !loops;
    transitionFromDisplayedPose(action, ACTION_CROSSFADE);
    restAction = null;
    activeAction = action;
    activeClipIndex = index;
    clipFinished = false;
    pendingRestTransition = false;
    animationStatus.value = profile.label + ' · ' + clip.duration.toFixed(1) + ' s · ' + (loops ? 'loop' : 'play once');
    streetControls?.setPlayback(clip.name);
    for (let item = 0; item < clipButtons.length; item++) {
      const selected = item === index;
      clipButtons[item].classList.toggle('is-active', selected);
      clipButtons[item].setAttribute('aria-pressed', String(selected));
    }
    syncSkillButtons();
    syncStreetStatus();
    setPlaybackButtons();
  };

  /** Fades the current action into the shared Gongshou rest pose without a hard cut. */
  const fadeToRest = (immediate = false): void => {
    if (!runtime) return;
    // The export freeze owns the live pose; a rest fade would change the captured frame.
    if (exportAnimationFrozen) return;
    // The rest pose is already on screen; fading again would restart its cross-fade.
    if (!immediate && restAction && !activeAction) return;
    const restClip = runtime.model.userData.sharedGongshouRestClip as THREE.AnimationClip | undefined;
    if (!restClip) return;
    const nextRest = runtime.mixer.clipAction(restClip, runtime.model);
    nextRest.setLoop(THREE.LoopRepeat, Infinity);
    transitionFromDisplayedPose(nextRest, immediate ? 0 : REST_CROSSFADE);
    restAction = nextRest;
    // The robot rests now, but the Play button still offers the clip that just finished.
    activeAction = null;
    clipFinished = false;
    pendingRestTransition = false;
    // The host stopped playing a clip: the controller releases the one-shot skill lock.
    streetControls?.setPlayback(null);
    for (const button of clipButtons) {
      button.classList.remove('is-active');
      button.setAttribute('aria-pressed', 'false');
    }
    syncSkillButtons();
    syncStreetStatus();
    setPlaybackButtons();
  };

  const stopAnimation = (): void => {
    if (!runtime) return;
    // The export freeze owns the live pose; stopping would change the captured frame.
    if (exportAnimationFrozen) return;
    activeAction = null;
    activeClipIndex = null;
    restAction = null;
    clipFinished = false;
    pendingRestTransition = false;
    animationStatus.value = 'Rest pose';
    // The host stopped playing a clip: the controller releases the one-shot skill lock.
    streetControls?.setPlayback(null);
    // An explicit stop also releases the held arrows, so the robot does not walk again.
    streetControls?.clearInput();
    fadeToRest(true);
    for (const button of clipButtons) {
      button.classList.remove('is-active');
      button.setAttribute('aria-pressed', 'false');
    }
    syncSkillButtons();
    syncStreetStatus();
    setPlaybackButtons();
  };

  playPauseButton.addEventListener('click', () => {
    if (!runtime) return;
    // The export freeze owns the live pose and its action weight.
    if (exportAnimationFrozen) return;
    if (!activeAction || clipFinished) {
      playClip(activeClipIndex ?? 0);
      return;
    }
    activeAction.paused = !activeAction.paused;
    // A paused pose must not keep walking: release the held arrows, but keep the frozen action
    // itself so the pose and its weight survive until the user resumes or stops.
    if (activeAction.paused) streetControls?.clearInput();
    const profile = getRobotAnimationProfile(activeAction.getClip().name);
    animationStatus.value = (activeAction.paused ? 'Paused · ' : 'Playing · ') + (profile?.label ?? labelForClip(activeAction.getClip().name, activeClipIndex ?? 0));
    syncStreetStatus();
    setPlaybackButtons();
  });
  stopButton.addEventListener('click', stopAnimation);

  const onRotate = (): void => {
    if (exportAnimationFrozen) return;
    rotationOn = !rotationOn;
    controls.autoRotate = rotationOn;
    rotateButton.setAttribute('aria-pressed', String(rotationOn));
    rotateButton.title = rotationOn ? 'Stop turntable rotation' : 'Start slow turntable rotation';
    rotateButton.classList.toggle('is-active', rotationOn);
  };
  rotateButton.addEventListener('click', onRotate);
  resetViewButton.addEventListener('click', () => {
    if (exportAnimationFrozen) return;
    // The reset frames the robot where it actually stands on the street, not at the origin.
    const anchor = streetControls?.position ?? STREET_ORIGIN;
    camera.position.copy(STREET_CAMERA_OFFSET).add(anchor);
    controls.target.set(anchor.x, 1.03, anchor.z);
    controls.update();
  });

  const mountSegments = (modelRuntime: RobotRuntime): void => {
    segmentList.replaceChildren();
    rowButtons.clear();
    const mappedVertices = [...modelRuntime.segments.values()].reduce((total, segment) => total + segment.vertexCount, 0);
    const sourceVertices = modelRuntime.meshes.reduce(
      (total, mesh) => total + (mesh.geometry.getAttribute('position')?.count ?? 0),
      0,
    );
    if (mappedVertices !== sourceVertices || sourceVertices !== modelRuntime.segmentation.totalVertexCount) {
      throw new Error('Segment coverage mismatch: ' + mappedVertices + ' mapped vertices for ' + sourceVertices + ' source vertices.');
    }
    for (const segment of modelRuntime.segments.values()) {
      if (segment.vertexCount === 0) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'robot-segment-row';
      button.dataset.segmentId = segment.id;
      button.title = 'Select ' + segment.label + ' segment';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', segment.label + ', ' + segment.vertexCount.toLocaleString() + ' skin-weighted vertices');
      const swatch = document.createElement('span');
      swatch.className = 'robot-segment-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.backgroundColor = robotSegmentColor(segment);
      const label = document.createElement('span');
      label.className = 'robot-segment-label';
      label.textContent = segment.label;
      const count = document.createElement('span');
      count.className = 'robot-segment-count';
      count.textContent = segment.vertexCount >= 1000 ? (segment.vertexCount / 1000).toFixed(1) + 'k' : String(segment.vertexCount);
      button.append(swatch, label, count);
      button.disabled = false;
      button.addEventListener('click', () => selectSegment(segment.id));
      segmentList.appendChild(button);
      rowButtons.set(segment.id, button);
    }
    segmentTotal.textContent = mappedVertices.toLocaleString() + ' vertices mapped';
    syncSegmentRows();
  };

  const mountClips = (modelRuntime: RobotRuntime): void => {
    clipList.replaceChildren();
    clipButtons.length = 0;
    for (let index = 0; index < modelRuntime.clips.length; index++) {
      const clip = modelRuntime.clips[index];
      const profile = getRobotAnimationProfile(clip.name);
      if (!profile) throw new Error('Clip ' + clip.name + ' has no measured playback profile.');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'robot-clip-button';
      button.dataset.clipIndex = String(index);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Play ' + profile.label + (profile.loop ? ' in a loop' : ' once'));
      const label = document.createElement('span');
      label.className = 'robot-clip-name';
      label.textContent = profile.label;
      const duration = document.createElement('span');
      duration.className = 'robot-clip-duration';
      duration.textContent = clip.duration.toFixed(1) + 's · ' + (profile.loop ? 'loop' : 'once');
      button.append(label, duration);
      button.addEventListener('click', () => playClip(index));
      clipList.appendChild(button);
      clipButtons.push(button);
    }
  };

  /**
   * Builds the nine street skill buttons. The buttons exist from the first paint so the section
   * reads as a control surface before the source loads; they stay disabled until the runtime
   * resolved their native clip.
   */
  const mountSkills = (): void => {
    skillList.replaceChildren();
    skillButtons.length = 0;
    for (const skill of ROBOT_STREET_SKILLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'robot-skill-button';
      button.dataset.skillKey = String(skill.key);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Play ' + skill.label + ' once');
      button.title = skill.label + ' · press ' + skill.key;
      const key = document.createElement('kbd');
      key.className = 'robot-skill-key';
      key.textContent = String(skill.key);
      const label = document.createElement('span');
      label.className = 'robot-skill-name';
      label.textContent = skill.label;
      button.append(key, label);
      button.disabled = true;
      button.addEventListener('click', () => playSkill(skill.key));
      skillList.appendChild(button);
      skillButtons.push(button);
    }
  };

  /**
   * Resolves the native clip behind every street skill. The keyboard and the buttons use the
   * same source prefixes, so both always play the identical native clip.
   */
  const resolveSkills = (modelRuntime: RobotRuntime): void => {
    skillClipNames.length = 0;
    skillClipIndices.length = 0;
    for (const skill of ROBOT_STREET_SKILLS) {
      const match = modelRuntime.clips.findIndex((clip) => clip.name.startsWith(skill.sourcePrefix));
      if (match < 0) throw new Error('Street skill ' + skill.key + ' has no native clip for ' + skill.sourcePrefix + '.');
      skillClipIndices.push(match);
      skillClipNames.push(modelRuntime.clips[match].name);
    }
  };

  /** Plays one street skill by its 1..9 key, resolving the native clip index the same way the controller does. */
  const playSkill = (key: number): void => {
    if (!runtime) return;
    const slot = ROBOT_STREET_SKILLS.findIndex((skill) => skill.key === key);
    if (slot < 0 || slot >= skillClipIndices.length) return;
    const index = skillClipIndices[slot];
    if (index === undefined) return;
    playClip(index, 'once');
  };

  /**
   * Creates the street controller once the native model is ready. The controller owns the
   * arrow-key walk, the grounded navigation and the camera follow; the host only answers its
   * playback requests.
   */
  const mountStreetControls = (modelRuntime: RobotRuntime, model: THREE.Group): void => {
    streetControls = createRobotStreetControls({
      runtime: modelRuntime,
      actor: model,
      camera,
      controls,
      canvas: renderer.domElement,
      canInteract: () => !disposed && rendererReady && !exportAnimationFrozen,
      onMove: (clipIndex: number) => {
        playClip(clipIndex, 'loop');
      },
      onRest: () => {
        // A paused action owns the pose; fading to rest would destroy the frozen frame.
        if (activeAction && activeAction.paused) return;
        fadeToRest();
      },
      onSkill: (clipIndex: number) => {
        playClip(clipIndex, 'once');
      },
    });
  };

  const exposeDeveloperAudit = (modelRuntime: RobotRuntime): void => {
    if (!import.meta.env.DEV) return;
    const debug: RobotStudioDebug = {
      ready: true,
      meshCount: modelRuntime.meshes.length,
      vertexCount: modelRuntime.segmentation.totalVertexCount,
      jointCount: modelRuntime.meshes[0]?.skeleton.bones.length ?? 0,
      triangleCount: modelRuntime.triangleCount,
      clips: modelRuntime.clips.map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length })),
      segments: [...modelRuntime.segments.values()].map((segment) => ({
        id: segment.id,
        label: segment.label,
        meshCount: segment.meshes.length,
        vertexCount: segment.vertexCount,
        center: segment.center.toArray(),
      })),
      auditClips: () => modelRuntime.clips.map((clip) => ({
        name: clip.name,
        tracks: clip.tracks.length,
        duration: clip.duration,
        ...auditClip(modelRuntime, clip),
      })),
      street: () => {
        if (!streetControls) return null;
        const state = streetControls.getState();
        return {
          position: state.position,
          moving: state.moving,
          clip: state.clip,
          heldKeys: state.heldKeys,
          activeClip: activeAction ? activeAction.getClip().name : null,
          exportFrozen: exportAnimationFrozen,
        };
      },
    };
    (window as unknown as { __ROBOT_STUDIO__?: RobotStudioDebug }).__ROBOT_STUDIO__ = debug;
  };

  const onLoadProgress = (progress: { loaded: number; total: number }): void => {
    if (disposed) return;
    loadingTitle.textContent = 'loading';
    if (progress.total > 0) {
      const percent = Math.max(0, Math.min(100, progress.loaded / progress.total * 100));
      progressFill.style.width = percent.toFixed(1) + '%';
      loadingCopy.textContent = Math.round(percent) + '% · ' + (progress.loaded / 1048576).toFixed(1) + ' MB transferred';
    } else {
      loadingCopy.textContent = (progress.loaded / 1048576).toFixed(1) + ' MB transferred';
    }
  };

  // --- Host-supplied export panel --------------------------------------------------
  // The page stays free of any importers the portable source package does not ship (exporters.ts
  // pulls in GLTFLoader for round-trip validation, and the source ZIP contract bans that import).
  // The host route (demo.ts) injects an export handler that owns all interchange / source-download
  // code. The page is responsible for freezing the animation + locking edits during a busy asset
  // export; the handler owns status text, downloads, and any QA hooks it wants to publish.
  // The freeze gates the renderFrame mixer update only and never touches activeAction, the mixer,
  // or any AnimationAction state, so the live pose, weight, finished flag and crossfade all survive
  // a busy release byte-for-byte. setAssetBusy returns void — the handler invokes exporters between
  // setAssetBusy(true) and setAssetBusy(false) directly.
  const setControlDisabled = (control: HTMLButtonElement | HTMLInputElement, disabled: boolean): void => {
    control.disabled = disabled;
  };
  const exportHandler = options.mountExports
    ? options.mountExports({
        mount,
        demo,
        getRuntime: () => (displayRoot && runtime ? { displayRoot, runtime } : null),
        isDisposed: () => disposed,
        setAssetBusy: (busy: boolean) => {
          if (disposed) return;
          if (busy) {
            if (exportAnimationFrozen) return;
            exportAnimationFrozen = true;
            clock.stop();
            // The export captures the live pose, so no arrow may stay held: release the input
            // and let the controller know the world is frozen.
            streetControls?.clearInput();
            const clipButtonStates = new Map<HTMLButtonElement, boolean>();
            for (const button of clipButtons) clipButtonStates.set(button, button.disabled);
            const skillButtonStates = new Map<HTMLButtonElement, boolean>();
            for (const button of skillButtons) skillButtonStates.set(button, button.disabled);
            const rowButtonStates = new Map<HTMLButtonElement, boolean>();
            for (const button of rowButtons.values()) rowButtonStates.set(button, button.disabled);
            exportControlSnapshot = {
              controlsEnabled: controls.enabled,
              panelColor: panelColor.disabled,
              floatingColor: floatingColor.disabled,
              resetSegmentButton: resetSegmentButton.disabled,
              resetAllButton: resetAllButton.disabled,
              playPauseButton: playPauseButton.disabled,
              stopButton: stopButton.disabled,
              rotateButton: rotateButton.disabled,
              resetViewButton: resetViewButton.disabled,
              clipButtons: clipButtonStates,
              skillButtons: skillButtonStates,
              rowButtons: rowButtonStates,
            };
            setControlDisabled(panelColor, true);
            setControlDisabled(floatingColor, true);
            setControlDisabled(resetSegmentButton, true);
            setControlDisabled(resetAllButton, true);
            setControlDisabled(playPauseButton, true);
            setControlDisabled(stopButton, true);
            setControlDisabled(rotateButton, true);
            setControlDisabled(resetViewButton, true);
            for (const button of clipButtons) setControlDisabled(button, true);
            for (const button of skillButtons) setControlDisabled(button, true);
            for (const button of rowButtons.values()) setControlDisabled(button, true);
            controls.enabled = false;
          } else {
            if (!exportAnimationFrozen) return;
            exportAnimationFrozen = false;
            clock.start();
            const saved = exportControlSnapshot;
            exportControlSnapshot = null;
            if (saved) {
              controls.enabled = saved.controlsEnabled;
              setControlDisabled(panelColor, saved.panelColor);
              setControlDisabled(floatingColor, saved.floatingColor);
              setControlDisabled(resetSegmentButton, saved.resetSegmentButton);
              setControlDisabled(resetAllButton, saved.resetAllButton);
              setControlDisabled(playPauseButton, saved.playPauseButton);
              setControlDisabled(stopButton, saved.stopButton);
              setControlDisabled(rotateButton, saved.rotateButton);
              setControlDisabled(resetViewButton, saved.resetViewButton);
              for (const [button, wasDisabled] of saved.clipButtons) setControlDisabled(button, wasDisabled);
              for (const [button, wasDisabled] of saved.skillButtons) setControlDisabled(button, wasDisabled);
              for (const [button, wasDisabled] of saved.rowButtons) setControlDisabled(button, wasDisabled);
            }
          }
        },
      })
    : null;

  displayRoot = createRobotModel(scene, onLoadProgress);
  // The nine street skill buttons render immediately; they stay disabled until the native
  // runtime resolved the clip behind each skill.
  mountSkills();
  void waitForRobotModel(displayRoot).then((loadedRuntime) => {
    if (disposed || !loadedRuntime) return;
    runtime = loadedRuntime;
    canonicalRobotInverse.copy(runtime.displayRoot.matrixWorld).invert();
    if (rendererFailureMessage) {
      showRendererFailure(new Error(rendererFailureMessage));
      return;
    }
    const bridgeTimes = new Float32Array([0, 1]);
    const bridgeTracks: THREE.KeyframeTrack[] = [];
    for (const bone of runtime.meshes[0].skeleton.bones) {
      const position = new THREE.VectorKeyframeTrack(bone.name + '.position', bridgeTimes, new Float32Array(6));
      const quaternion = new THREE.QuaternionKeyframeTrack(bone.name + '.quaternion', bridgeTimes, new Float32Array(8));
      const scale = new THREE.VectorKeyframeTrack(bone.name + '.scale', bridgeTimes, new Float32Array(6));
      bridgeTracks.push(position, quaternion, scale);
      poseBridgeBones.push({
        bone,
        position: position.values,
        quaternion: quaternion.values,
        scale: scale.values,
        rawPosition: new THREE.Vector3(),
        rawQuaternion: new THREE.Quaternion(),
      });
    }
    poseBridgeAction = runtime.mixer.clipAction(
      new THREE.AnimationClip('studio-displayed-pose-bridge', 1, bridgeTracks),
      runtime.model,
    );
    mountSegments(runtime);
    mountClips(runtime);
    resolveSkills(runtime);
    mountStreetControls(runtime, runtime.displayRoot);
    fadeToRest();
    meshCount.textContent = String(runtime.meshes.length);
    jointCount.textContent = String(runtime.meshes[0]?.skeleton.bones.length ?? 0);
    clipCount.textContent = String(runtime.clips.length);
    query<HTMLElement>('#robot-loading-title').textContent = 'Source surface ready';
    loadingCopy.textContent = runtime.meshes.length + ' skinned mesh · ' + runtime.segmentation.totalVertexCount.toLocaleString() + ' vertices · ' + runtime.clips.length + ' measured clips';
    progressFill.style.width = '100%';
    setHeaderState('Source surface ready', 'ready');
    animationStatus.value = 'Rest pose · select a clip';
    syncStreetStatus();
    playPauseButton.disabled = runtime.clips.length === 0;
    stopButton.disabled = runtime.clips.length === 0;
    resetAllButton.disabled = false;
    // The street skills stay locked until the native runtime is ready.
    for (const button of skillButtons) button.disabled = false;
    loading.classList.add('is-complete');
    window.setTimeout(() => { if (!disposed) loading.hidden = true; }, 360);
    exposeDeveloperAudit(runtime);
    runtime.mixer.addEventListener('finished', onAnimationFinished);
    if (exportHandler) exportHandler.ready();
    // Clips start only after selection; the source rest pose is the initial preview.
    window.requestAnimationFrame(() => {
      if (!disposed) (window as unknown as { __IMG2THREEJS_READY__?: boolean }).__IMG2THREEJS_READY__ = true;
    });
  }).catch((error: unknown) => {
    if (disposed || rendererFailureMessage) return;
    const message = error instanceof Error ? error.message : 'The robot model could not be loaded.';
    loading.classList.add('is-error');
    loadingTitle.textContent = 'Source model could not be loaded';
    loadingCopy.textContent = message;
    setHeaderState('Load failed', 'error');
    console.error('Robot showcase load failed:', error);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !floatingPicker.hidden) floatingPicker.hidden = true;
  };
  window.addEventListener('keydown', onKeyDown);

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    // The controller owns every window/document listener it added; disposing it here keeps the
    // route free of ghost arrow handlers after a remount.
    streetControls?.dispose();
    streetControls = null;
    streetEnvironment.dispose();
    controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKeyDown);
    if (runtime) runtime.mixer.removeEventListener('finished', onAnimationFinished);
    if (exportHandler) exportHandler.dispose();
    if (displayRoot) disposeRobotModel(displayRoot, runtime);
    if (rendererReady) disposeRenderer();
    renderer.domElement.remove();
    const globals = window as unknown as { __IMG2THREEJS_READY__?: boolean; __ROBOT_STUDIO__?: RobotStudioDebug };
    globals.__IMG2THREEJS_READY__ = false;
    delete globals.__ROBOT_STUDIO__;
    mount.replaceChildren();
  };
}
