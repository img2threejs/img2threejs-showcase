import * as THREE from 'three';
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
import '../demos/man-robot-studio/robotStudio.css';

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
  '      <div class="robot-stage-caption"><span>DRAG TO ORBIT <i>·</i> SCROLL TO ZOOM</span><span id="robot-stage-caption-right">CLICK A PART TO COLOR</span></div>',
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

export function renderRobotStudio(mount: HTMLElement, demo: DemoEntry): () => void {
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
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
  camera.position.set(0, 2.18, 4.05);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', 'Robot model. Drag to orbit and click a surface to select its segment.');
  renderer.domElement.tabIndex = 0;
  renderer.domElement.className = 'robot-webgl-canvas';
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

  const hemisphere = new THREE.HemisphereLight(0xe4f7f1, 0x13191d, 1.72);
  scene.add(hemisphere);
  const keyLight = new THREE.DirectionalLight(0xfff2df, 3.1);
  keyLight.position.set(-3.8, 5.8, 4.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 18;
  keyLight.shadow.bias = -0.00025;
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x8fb4ff, 2.25);
  rimLight.position.set(3.8, 3.6, -4.5);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0xb4e9dc, 0.8);
  fillLight.position.set(4.2, 1.8, 3.2);
  scene.add(fillLight);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.ShadowMaterial({ color: '#05080a', opacity: 0.25 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.004;
  floor.receiveShadow = true;
  floor.name = 'robot-studio-shadow-floor';
  scene.add(floor);

  let disposed = false;
  let frame = 0;
  let runtime: RobotRuntime | null = null;
  let displayRoot: THREE.Group | null = null;
  let activeSegment: RobotSegmentId | null = null;
  let activeAction: THREE.AnimationAction | null = null;
  let activeClipIndex: number | null = null;
  let clipFinished = false;
  let pendingRestTransition = false;
  let pointerStart: { x: number; y: number } | null = null;
  const rowButtons = new Map<RobotSegmentId, HTMLButtonElement>();
  const clipButtons: HTMLButtonElement[] = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = new THREE.Clock();
  const marker = new THREE.Vector3();
  const modelScale = 2.15;
  let rotationOn = false;

  const resize = (): void => {
    const width = Math.max(1, canvasMount.clientWidth);
    const height = Math.max(1, canvasMount.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvasMount);
  resize();

  const renderFrame = (): void => {
    if (disposed) return;
    frame = requestAnimationFrame(renderFrame);
    const delta = Math.min(clock.getDelta(), 0.1);
    if (runtime) {
      resetRobotAnimationCorrection(runtime);
      runtime.mixer.update(delta);
      if (activeAction) {
        applyRobotAnimationCorrection(runtime, activeAction.getClip().name, activeAction.time);
      }
      if (pendingRestTransition && activeAction) {
        pendingRestTransition = false;
        const restClip = runtime.model.userData.sharedGongshouRestClip as THREE.AnimationClip | undefined;
        if (restClip) {
          const restAction = runtime.mixer.clipAction(restClip, runtime.model);
          restAction.reset()
            .setLoop(THREE.LoopRepeat, Infinity)
            .setEffectiveWeight(1)
            .setEffectiveTimeScale(1)
            .play();
          activeAction.crossFadeTo(restAction, 0.35, false);
        }
      }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(renderFrame);

  const setHeaderState = (text: string, state: 'loading' | 'ready' | 'error'): void => {
    headerState.dataset.state = state;
    const statusText = headerState.querySelector('span:last-child');
    if (statusText) statusText.textContent = text;
  };

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
    runtime?.model.updateMatrixWorld(true);
    marker.copy(point).project(camera);
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
    if (!runtime) return;
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
    query<HTMLElement>('#robot-stage-caption-right').textContent = 'CLICK A PART TO COLOR';
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
    if (!runtime || !activeSegment) return;
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

  const onAnimationFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== activeAction) return;
    clipFinished = true;
    pendingRestTransition = true;
    const clip = event.action.getClip();
    const profile = getRobotAnimationProfile(clip.name);
    animationStatus.value = 'Completed · ' + (profile?.label ?? labelForClip(clip.name, activeClipIndex ?? 0));
    setPlaybackButtons();
  };

  const playClip = (index: number): void => {
    if (!runtime || !runtime.clips[index]) return;
    const clip = runtime.clips[index];
    const profile = getRobotAnimationProfile(clip.name);
    if (!profile) throw new Error('Clip ' + clip.name + ' has no measured playback mode.');
    resetRobotAnimationCorrection(runtime);
    runtime.mixer.stopAllAction();
    runtime.mixer.timeScale = 1;
    const action = runtime.mixer.clipAction(clip, runtime.model);
    action.reset();
    action.enabled = true;
    action.setLoop(profile.loop ? THREE.LoopRepeat : THREE.LoopOnce, profile.loop ? Infinity : 1);
    action.clampWhenFinished = !profile.loop;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    activeAction = action;
    activeClipIndex = index;
    clipFinished = false;
    pendingRestTransition = false;
    animationStatus.value = profile.label + ' · ' + clip.duration.toFixed(1) + ' s · ' + (profile.loop ? 'loop' : 'play once');
    for (let item = 0; item < clipButtons.length; item++) {
      const selected = item === index;
      clipButtons[item].classList.toggle('is-active', selected);
      clipButtons[item].setAttribute('aria-pressed', String(selected));
    }
    setPlaybackButtons();
  };

  const stopAnimation = (): void => {
    if (!runtime) return;
    resetRobotAnimationCorrection(runtime);
    runtime.mixer.stopAllAction();
    runtime.mixer.timeScale = 1;
    activeAction = null;
    activeClipIndex = null;
    clipFinished = false;
    pendingRestTransition = false;
    animationStatus.value = 'Rest pose';
    for (const button of clipButtons) {
      button.classList.remove('is-active');
      button.setAttribute('aria-pressed', 'false');
    }
    setPlaybackButtons();
  };

  playPauseButton.addEventListener('click', () => {
    if (!runtime) return;
    if (!activeAction || clipFinished) {
      playClip(activeClipIndex ?? 0);
      return;
    }
    activeAction.paused = !activeAction.paused;
    const profile = getRobotAnimationProfile(activeAction.getClip().name);
    animationStatus.value = (activeAction.paused ? 'Paused · ' : 'Playing · ') + (profile?.label ?? labelForClip(activeAction.getClip().name, activeClipIndex ?? 0));
    setPlaybackButtons();
  });
  stopButton.addEventListener('click', stopAnimation);

  const onRotate = (): void => {
    rotationOn = !rotationOn;
    controls.autoRotate = rotationOn;
    rotateButton.setAttribute('aria-pressed', String(rotationOn));
    rotateButton.title = rotationOn ? 'Stop turntable rotation' : 'Start slow turntable rotation';
    rotateButton.classList.toggle('is-active', rotationOn);
  };
  rotateButton.addEventListener('click', onRotate);
  resetViewButton.addEventListener('click', () => {
    camera.position.set(0, modelScale * 1.01395, modelScale * 1.88372);
    controls.target.set(0, 1.03, 0);
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
    };
    (window as unknown as { __ROBOT_STUDIO__?: RobotStudioDebug }).__ROBOT_STUDIO__ = debug;
  };

  const onLoadProgress = (progress: { loaded: number; total: number }): void => {
    if (disposed) return;
    loadingTitle.textContent = 'Loading the original GLB surface';
    if (progress.total > 0) {
      const percent = Math.max(0, Math.min(100, progress.loaded / progress.total * 100));
      progressFill.style.width = percent.toFixed(1) + '%';
      loadingCopy.textContent = Math.round(percent) + '% · ' + (progress.loaded / 1048576).toFixed(1) + ' MB transferred';
    } else {
      loadingCopy.textContent = (progress.loaded / 1048576).toFixed(1) + ' MB transferred';
    }
  };

  displayRoot = createRobotModel(scene, onLoadProgress);
  void waitForRobotModel(displayRoot).then((loadedRuntime) => {
    if (disposed || !loadedRuntime) return;
    runtime = loadedRuntime;
    mountSegments(runtime);
    mountClips(runtime);
    meshCount.textContent = String(runtime.meshes.length);
    jointCount.textContent = String(runtime.meshes[0]?.skeleton.bones.length ?? 0);
    clipCount.textContent = String(runtime.clips.length);
    query<HTMLElement>('#robot-loading-title').textContent = 'Source surface ready';
    loadingCopy.textContent = runtime.meshes.length + ' skinned mesh · ' + runtime.segmentation.totalVertexCount.toLocaleString() + ' vertices · ' + runtime.clips.length + ' measured clips';
    progressFill.style.width = '100%';
    setHeaderState('Source surface ready', 'ready');
    animationStatus.value = 'Rest pose · select a clip';
    playPauseButton.disabled = runtime.clips.length === 0;
    stopButton.disabled = runtime.clips.length === 0;
    resetAllButton.disabled = false;
    loading.classList.add('is-complete');
    window.setTimeout(() => { if (!disposed) loading.hidden = true; }, 360);
    exposeDeveloperAudit(runtime);
    runtime.mixer.addEventListener('finished', onAnimationFinished);
    // Clips start only after selection; the source rest pose is the initial preview.
    window.requestAnimationFrame(() => {
      if (!disposed) (window as unknown as { __IMG2THREEJS_READY__?: boolean }).__IMG2THREEJS_READY__ = true;
    });
  }).catch((error: unknown) => {
    if (disposed) return;
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
    controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKeyDown);
    if (runtime) runtime.mixer.removeEventListener('finished', onAnimationFinished);
    if (displayRoot) disposeRobotModel(displayRoot, runtime);
    renderer.dispose();
    renderer.domElement.remove();
    const globals = window as unknown as { __IMG2THREEJS_READY__?: boolean; __ROBOT_STUDIO__?: RobotStudioDebug };
    globals.__IMG2THREEJS_READY__ = false;
    delete globals.__ROBOT_STUDIO__;
    mount.replaceChildren();
  };
}
