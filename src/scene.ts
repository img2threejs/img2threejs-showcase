import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { fitScale, subjectExtent, type SubjectExtent } from './framing';

export interface ViewerOptions {
  /** Install per-demo lights into the scene. Falls back to a neutral studio rig. */
  installLights?: (scene: THREE.Scene) => void;
  cameraPosition?: [number, number, number];
  cameraTarget?: [number, number, number];
  cameraFov?: number;
  background?: number;
  /** Radial gradient backdrop (inner→outer hex) — a premium themed stage for hero props. */
  backgroundGradient?: { inner: string; outer: string };
  /** Tone-mapping operator (default 'aces'). 'agx' preserves saturated reds/crimson that ACES
   * desaturates toward pink/brown (critical for a Ruby-Doppler blade); 'neutral' scales linearly. */
  toneMapping?: 'aces' | 'agx' | 'neutral';
  /** Tone-mapping exposure (default 1.0). <1 darkens the whole render for a moody look. */
  exposure?: number;
  /** Scene environment (IBL) intensity (default 1.0). <1 cuts ambient fill. */
  environmentIntensity?: number;
  /**
   * Headless-evaluation capture mode (default false). When true the viewer renders on a flat
   * white studio background (to match reference-photo framing), skips the contact-shadow ground,
   * and freezes the camera (no orbit damping) so a deterministic PNG can be captured for the
   * Divine Eye reference loop. Does NOT change the object's own appearance — capture-only.
   */
  capture?: boolean;
  /** Side-on capture margin. Demos with photo plates that touch the frame can tighten this. */
  captureMargin?: number;
  /**
   * Orbit the camera slowly so every side of the subject is seen without the visitor having to drag
   * (default false). Forced off in capture mode: an evaluation render has to be the same camera every
   * run, and a moving one is the single surest way to guarantee it is not.
   */
  turntable?: boolean;
  /** Turntable rate in degrees per second (default 15, so a full revolution in 24 s). */
  turntableSpeed?: number;
}

/** An explicit review camera: geometry-independent, so a pass is measured rather than reframed. */
export interface PinnedCaptureCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

/**
 * How long the turntable stays still after a drag ends.
 *
 * Long enough that letting go to look at something is not immediately overruled, short enough that it
 * does not read as broken. Under about a second the orbit snatches the view back off the visitor.
 */
const TURNTABLE_RESUME_S = 2.5;

/**
 * Turntable rate, in degrees per second — a full revolution in 24 s.
 *
 * Slow enough to read a surface rather than smear it, quick enough that the far side arrives before the
 * visitor gives up and drags there by hand. In degrees per SECOND and not per frame on purpose: see
 * `spinTurntable`.
 */
const TURNTABLE_DEG_PER_S = 15;

/** Cap on the step the turntable will take, so a backgrounded tab does not resume with a lurch. */
const TURNTABLE_MAX_STEP_S = 1 / 15;

/** The turntable swings about world up: a subject is displayed by turning it, not by tumbling it. */
const TURNTABLE_AXIS = new THREE.Vector3(0, 1, 0);

/** A component a click can resolve to: the unit the inspector selects, names and isolates. */
export interface PartInfo {
  name: string;
  /** Assembly module, when the demo declares `sculptRuntime.destructionGroups`. */
  module: string | null;
  /**
   * `detail` = surface relief that rides a shell (a serration comb, a cable loom, a sight)
   * rather than a component you could hold in your hand. Every mesh under it is integral.
   */
  kind: 'part' | 'detail';
  triangles: number;
  /** One human-readable line per material slot, with the PBR scalars spelled out. */
  materials: string[];
  object: THREE.Object3D;
}

/** Model-level honesty note surfaced next to the part list, when the demo records one. */
export interface ProvenanceInfo {
  route?: string;
  exactnessTier?: string;
  familyAdapter?: string;
  thicknessConfidence?: number;
  inferred?: string[];
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

/** A mesh that carries real geometry — i.e. not one of the inspector's own overlay clones. */
function isRealMesh(o: THREE.Object3D): o is THREE.Mesh {
  return isMesh(o) && !!o.geometry && !o.userData.isHighlight;
}

function triangleCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (!isRealMesh(o)) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(n);
}

/**
 * Label a material by what it reads as, then give the numbers behind the label. The numbers
 * matter: "steel" is a claim, `metal 1.00 · rough 0.46` is what was actually authored.
 *
 * When a channel is driven by a texture the scalar is only a multiplier over it — a shell
 * carrying authored roughness/metalness maps sits at 1.0 on both and is neither fully rough
 * nor fully metallic. Printing that scalar would be a lie, so say "map" and print nothing.
 */
function describeMaterial(mat: THREE.Material): string {
  const m = mat as THREE.MeshPhysicalMaterial;
  if (typeof m.metalness !== 'number' || typeof m.roughness !== 'number') return mat.type;
  const trans = m.transmission ?? 0;
  const kind = trans > 0.05 ? 'translucent polymer'
    : m.metalnessMap || m.roughnessMap ? 'mapped surface'
      : m.metalness >= 0.85 ? 'steel'
        : m.metalness >= 0.45 ? 'gunmetal'
          : m.roughness >= 0.55 ? 'matte polymer'
            : 'polymer';
  const bits = [
    kind,
    `metal ${m.metalnessMap ? 'map' : m.metalness.toFixed(2)}`,
    `rough ${m.roughnessMap ? 'map' : m.roughness.toFixed(2)}`,
  ];
  if (trans > 0.05) bits.push(`transmission ${trans.toFixed(2)}`);
  return bits.join(' · ');
}

/** Build a radial-gradient backdrop as a CanvasTexture (colorSpace = SRGB for a colour bg). */
function makeGradientBackground(inner: string, outer: string): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.72);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Reusable Three.js viewer: renderer, camera, OrbitControls, PMREM environment,
 * a contact-shadow ground plane, resize handling, and a render loop.
 * Call dispose() before mounting a different demo to free GPU resources.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  /**
   * Per-frame updaters a demo exposes as `object.userData.tick`, resolved once and refreshable.
   *
   * Collecting them only inside `start()` misses every demo whose runtime arrives through `prewarm`:
   * the walk happens before the geometry lands, so the ticker is never picked up and the mixer never
   * advances -- the clips hold actions and play silently. Demos that build synchronously are
   * unaffected, and the re-walk is idempotent.
   */
  private tickers: Array<(dt: number, elapsed: number) => void> = [];

  /** Re-walk the scene for `userData.tick`. Call after late geometry lands. */
  refreshTickers(): void {
    const found: Array<(dt: number, elapsed: number) => void> = [];
    this.scene.traverse((object) => {
      const tick = (object.userData as { tick?: unknown }).tick;
      if (typeof tick === 'function') found.push(tick as (dt: number, elapsed: number) => void);
    });
    this.tickers = found;
  }

  private readonly mount: HTMLElement;
  private rafHandle = 0;
  private readonly onResize: () => void;
  private readonly capture: boolean;

  /**
   * Whether the turntable is WANTED, which is not the same as whether it is currently spinning: a drag
   * clears `turntableSpinning` and this is what the pause knows to restore. Reading the spinning flag
   * alone would make a toggle pressed mid-drag latch to the wrong state.
   */
  private turntableWanted = false;
  /** Seconds left before a drag-interrupted turntable picks itself back up. 0 = not waiting. */
  private turntableResume = 0;
  /** Whether the orbit advances THIS frame. False while a drag holds it, and through the resume wait. */
  private turntableSpinning = false;
  /** Rate in degrees per second. */
  private turntableRate = TURNTABLE_DEG_PER_S;

  private explodeRoot: THREE.Object3D | null = null;
  private explodeParts: Array<{ object: THREE.Object3D; rest: THREE.Vector3; offset: THREE.Vector3 }> | null = null;
  private explodeT = 0;
  private explodeTarget = 0;
  private explodeApplied = false;
  private explodeBaseDist = 0;
  /** How much the layout grows when fully separated — drives the camera dolly. */
  private explodeZoom = 1;

  private rigOn = false;
  private rigHelper: THREE.SkeletonHelper | null = null;
  private rigSaved: Array<{
    mesh: THREE.Mesh; material: THREE.Material | THREE.Material[];
    colour: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  }> = [];

  // ---- part inspector ----
  private inspectRoot: THREE.Object3D | null = null;
  private partList: PartInfo[] = [];
  private moduleOf = new Map<string, string>();
  private selection: PartInfo | null = null;
  private onSelectCb: ((sel: PartInfo | null) => void) | null = null;
  private highlightMat: THREE.MeshBasicMaterial | null = null;
  private highlightMeshes: THREE.Mesh[] = [];
  private isolateOn = false;
  private hiddenByIsolate: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  /** Repeat-click cycling state: same spot + same hit stack ⇒ step to the next part behind. */
  private pickKey = '';
  private pickIndex = 0;
  private pickDown: { x: number; y: number } | null = null;
  private teardown: Array<() => void> = [];
  /** Camera pose to ease toward while focusing a part, and the pose to come back to. */
  private camGoal: { target: THREE.Vector3; dist: number } | null = null;
  private camRest: { target: THREE.Vector3; dist: number } | null = null;

  // ---- responsive framing ----
  /** Distance the demo authored (|cameraPosition - cameraTarget|) — the desktop framing. */
  private readonly authoredDistance: number;
  private readonly authoredFar: number;
  /** Subject size around the orbit target; null until fitToViewport() runs. */
  private fitExtent: SubjectExtent | null = null;
  /** Distance applyFit() last set, so a resize can preserve the user's own zoom. */
  private appliedDistance = 0;
  private fogBase: { near: number; far: number } | null = null;

  constructor(mount: HTMLElement, options: ViewerOptions = {}) {
    this.mount = mount;

    // A mask capture keeps the same camera and draw list as the white studio
    // shot, but preserves mesh alpha so bright bare-metal pixels cannot be
    // mistaken for the background by the Tier-1 silhouette diagnostic.
    const maskCapture = options.capture === true
      && typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('mask') === '1';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: maskCapture });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = options.toneMapping === 'agx'
      ? THREE.AgXToneMapping
      : options.toneMapping === 'neutral'
        ? THREE.NeutralToneMapping
        : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = options.exposure ?? 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);

    this.capture = options.capture ?? false;

    this.scene = new THREE.Scene();

    // `?bg=RRGGBB` is read OUTSIDE the capture branch as well, because the two are independent needs.
    // Capture mode also runs frameForCapture, which keeps re-deriving the camera from the scene bounds
    // and reverts a pinned one — so a review that needs the profile's camera has to drop `capture=1`,
    // and it must not lose a uniform background by doing so. A gradient backdrop makes every
    // foreground threshold position-dependent; a single flat colour makes extraction exact.
    const bgOverride = (() => {
      if (typeof window === 'undefined') return null;
      const raw = new URLSearchParams(window.location.search).get('bg');
      return raw && /^#?[0-9a-fA-F]{6}$/.test(raw)
        ? new THREE.Color(parseInt(raw.replace('#', ''), 16))
        : null;
    })();

    if (this.capture) {
      // Flat white studio bg matches the reference photos (white-bg) → fair silhouette IoU.
      // Mask captures intentionally leave the clear color transparent for
      // alpha-based foreground extraction; they are diagnostic evidence only.
      //
      // `?bg=RRGGBB` overrides the white for a subject whose reference is NOT on white. That is not
      // a preference: a render captured on white while its reference sits on #0f0f0f makes every
      // foreground/silhouette number a measurement of the mismatch rather than of the model. The
      // default stays white so every existing demo captures byte-identically.
      this.scene.background = maskCapture ? null : (bgOverride ?? new THREE.Color(0xffffff));
    } else if (bgOverride) {
      this.scene.background = bgOverride;
    } else if (options.backgroundGradient) {
      this.scene.background = makeGradientBackground(
        options.backgroundGradient.inner,
        options.backgroundGradient.outer,
      );
    } else {
      this.scene.background = new THREE.Color(options.background ?? 0x1b1d24);
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = options.environmentIntensity ?? 1.0;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(options.cameraFov ?? 36, 1, 0.1, 100);
    const [px, py, pz] = options.cameraPosition ?? [1.6, 1.1, 2.4];
    this.camera.position.set(px, py, pz);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Freeze the camera in capture mode so evaluation renders are deterministic.
    this.controls.enableDamping = !this.capture;
    this.controls.enabled = !this.capture;
    const [tx, ty, tz] = options.cameraTarget ?? [0, 0, 0];
    this.controls.target.set(tx, ty, tz);
    this.controls.update();

    this.authoredDistance = this.camera.position.distanceTo(this.controls.target);
    this.authoredFar = this.camera.far;

    // ---- turntable -----------------------------------------------------------------------------
    //
    // IT MOVES THE CAMERA, NEVER THE MODEL, and that is the whole reason it is here rather than in a
    // demo's ticker. Spinning the model would have to compose with two things that do not compose for
    // free: the explode offsets, which are written in each part's own parent frame (see `applyExplode`),
    // and the tickers that write vertex positions directly -- a breathing chest among them. Orbiting the
    // camera touches neither, so every angle is shown with the parts, the picking and the deformation all
    // behaving exactly as they do standing still.
    //
    // IT IS DRIVEN BY ELAPSED TIME, NOT BY FRAMES, which is why `controls.autoRotate` is not used.
    // OrbitControls advances its orbit by a FIXED ANGLE PER `update()` CALL, a figure that only means what
    // it says at 60 fps. The heaviest subject here draws 1.6 M triangles and deforms vertices on the CPU
    // every frame, so it runs nearer 13 -- and the same nominal speed then gives a revolution several times
    // slower there than on a machine holding 60. A showcase whose turn rate is a function of the visitor's
    // GPU is not a showcase, so the angle is integrated from dt in `spinTurntable` instead.
    //
    // A slow full-viewport orbit is exactly the kind of motion `prefers-reduced-motion` is about, so the
    // OS setting decides the DEFAULT. It does not disable the feature: the toolbar toggle still turns it
    // on for anyone who wants it, which is why this gates the initial value and not `setTurntable`.
    const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.turntableWanted = !this.capture && !reduceMotion && (options.turntable ?? false);
    this.turntableSpinning = this.turntableWanted;
    this.turntableRate = options.turntableSpeed ?? TURNTABLE_DEG_PER_S;
    // The hand wins while it is on, and the orbit picks itself back up a beat after it comes off.
    // Without the pause the spin fights the drag; without the resume a visitor loses the feature
    // permanently by using it once.
    this.controls.addEventListener('start', () => {
      this.turntableSpinning = false;
      this.turntableResume = 0;
    });
    this.controls.addEventListener('end', () => {
      if (this.turntableWanted) this.turntableResume = TURNTABLE_RESUME_S;
    });

    if (options.installLights) {
      options.installLights(this.scene);
    } else {
      installDefaultStudioLights(this.scene);
    }

    // Skip the contact-shadow ground in capture mode: the reference photos have no cast shadow,
    // and a shadow blob on the white bg would pollute the silhouette IoU.
    if (!this.capture) {
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 30),
        new THREE.ShadowMaterial({ opacity: 0.16 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.scene.add(ground);
    }

    this.onResize = () => this.handleResize();
    window.addEventListener('resize', this.onResize);
    this.handleResize();
  }

  /**
   * Registers the demo's model root as the thing the explode control pulls apart.
   * Optional — without it `setExplode` is a no-op and the button stays hidden.
   */
  setExplodeRoot(root: THREE.Object3D): void {
    this.explodeRoot = root;
    this.explodeParts = null; // recomputed lazily on first explode
  }

  /**
   * Run a synchronous asset snapshot against the authored assembly.
   *
   * Inspector highlights, isolation, explode offsets and the rig-debug material are viewer tools, not
   * asset data. They are removed only for the duration of the clone and restored before the browser can
   * render another frame. Bone transforms are deliberately left alone so static formats bake the pose
   * the visitor is actually looking at.
   */
  withAssetExportState<T>(snapshot: () => T): T {
    const rigWasOn = this.rigOn;
    if (rigWasOn) this.setRigView(false);

    const hidden = this.hiddenByIsolate.map((mesh) => ({ mesh, visible: mesh.visible }));
    for (const item of hidden) item.mesh.visible = true;

    const selected = this.selection;
    this.clearHighlight();

    const exploded = (this.explodeParts ?? []).map((part) => ({
      object: part.object,
      position: part.object.position.clone(),
      rest: part.rest,
    }));
    for (const part of exploded) part.object.position.copy(part.rest);
    this.explodeRoot?.updateMatrixWorld(true);

    try {
      return snapshot();
    } finally {
      for (const part of exploded) part.object.position.copy(part.position);
      for (const item of hidden) item.mesh.visible = item.visible;
      if (rigWasOn) this.setRigView(true);
      if (selected) this.addHighlight(selected.object);
      this.explodeRoot?.updateMatrixWorld(true);
    }
  }

  /** True once a root with more than one mesh is registered, i.e. worth offering the control. */
  get canExplode(): boolean {
    if (!this.explodeRoot) return false;
    let n = 0;
    this.explodeRoot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    return n > 1;
  }

  /** True once the registered root contains a skinned mesh, i.e. there is a rig worth showing. */
  get canShowRig(): boolean {
    if (!this.explodeRoot) return false;
    let found = false;
    this.explodeRoot.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) found = true; });
    return found;
  }

  /**
   * Paint every surface by the BONES THAT MOVE IT, and draw the skeleton over the top.
   *
   * A rig is reviewed by seeing which bone owns which piece of surface, and where one bone's territory
   * gives way to the next. So each vertex takes its bones' colours mixed by their own weights -- not the
   * dominant bone alone, because a hard-edged map hides exactly the thing worth looking at, which is
   * whether the handover between two bones is a gradient or a cliff. A crease at a joint shows here as a
   * sharp colour boundary; a part bound to the wrong side shows as the wrong colour outright.
   *
   * Hues walk the colour wheel by the golden angle in skeleton order, so a bone and its parent never come
   * out the same shade.
   */
  setRigView(on: boolean): void {
    if (on === this.rigOn) return;
    this.rigOn = on;
    if (!on) {
      for (const saved of this.rigSaved) {
        saved.mesh.material = saved.material;
        if (saved.colour) saved.mesh.geometry.setAttribute('color', saved.colour);
        else saved.mesh.geometry.deleteAttribute('color');
      }
      this.rigSaved = [];
      if (this.rigHelper) {
        this.rigHelper.removeFromParent();
        this.rigHelper.dispose();
        this.rigHelper = null;
      }
      return;
    }
    if (!this.explodeRoot) return;

    const hue = new Map<string, THREE.Color>();
    const colourFor = (name: string, i: number): THREE.Color => {
      let c = hue.get(name);
      if (!c) {
        c = new THREE.Color().setHSL((i * 0.61803398875) % 1, 0.72, 0.55);
        hue.set(name, c);
      }
      return c;
    };

    let first: THREE.SkinnedMesh | null = null;
    this.explodeRoot.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
      if (!first) first = mesh;
      const geo = mesh.geometry;
      const idx = geo.getAttribute('skinIndex');
      const wgt = geo.getAttribute('skinWeight');
      if (!idx || !wgt) return;
      this.rigSaved.push({
        mesh, material: mesh.material, colour: geo.getAttribute('color') as never,
      });
      const colours = new Float32Array(idx.count * 3);
      const mixed = new THREE.Color();
      for (let v = 0; v < idx.count; v += 1) {
        mixed.setRGB(0, 0, 0);
        for (let k = 0; k < 4; k += 1) {
          const w = wgt.getComponent(v, k);
          if (w <= 0.001) continue;
          const bi = idx.getComponent(v, k);
          const bone = mesh.skeleton.bones[bi];
          if (!bone) continue;
          const c = colourFor(bone.name, bi);
          mixed.r += c.r * w;
          mixed.g += c.g * w;
          mixed.b += c.b * w;
        }
        colours[v * 3] = mixed.r;
        colours[v * 3 + 1] = mixed.g;
        colours[v * 3 + 2] = mixed.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      mesh.material = new THREE.MeshLambertMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      });
    });

    if (first) {
      // Drawn without depth testing, because the interesting bones are the ones inside the body.
      const helper = new THREE.SkeletonHelper((first as THREE.SkinnedMesh).skeleton.bones[0]);
      const mat = helper.material as THREE.LineBasicMaterial;
      mat.depthTest = false;
      mat.transparent = true;
      mat.opacity = 0.9;
      helper.renderOrder = 999;
      this.scene.add(helper);
      this.rigHelper = helper;
    }
  }

  /** 0 = assembled, 1 = fully separated. The render loop eases toward this. */
  setExplode(t: number): void {
    const next = Math.max(0, Math.min(1, t));
    // AN EXPLODE OF ONE PART IS AN EXPLODE OF NOTHING, so isolate cannot be left standing through it.
    // Isolate hides every component but the selected one; separating them then moved 31 hidden meshes
    // and the visitor watched a figure that did not budge -- while the button latched to "Assemble" and
    // reported the success it had not had. Coming apart is a statement about the whole assembly, so it
    // wins over looking at one piece of it, and `setIsolate` is what tells the inspector UI, whose
    // toggle would otherwise go on claiming the model is isolated.
    if (next > 0) {
      if (this.isolateOn) this.setIsolate(false);
      this.snapToRestFraming();
    }
    // Capture the framing distance the moment we leave the assembled pose, so the dolly
    // below has a stable base even if the viewer zoomed since the last explode.
    if (this.explodeT === 0 && next > 0) {
      this.explodeBaseDist = this.camera.position.distanceTo(this.controls.target);
    }
    this.explodeTarget = next;
  }

  /**
   * Cut the camera straight back to the framing an inspector focus interrupted, discarding the ease.
   *
   * WHY A SNAP AND NOT AN EASE. Focusing on a part (and `clearIsolate` returning from one) leaves a
   * `camGoal` for `easeCamera`, which runs AFTER `applyExplode` in the loop and therefore wins every
   * frame it is alive. The dolly that keeps a separating assembly inside a tight framing was overridden
   * for the whole of the ease, and by the time the goal retired `explodeT` had already reached its target
   * -- so the dolly, which only runs while the two differ, never got to move: the head and the swords
   * simply left the viewport. Two easings cannot share the camera, and the explode is the one the visitor
   * just asked for, so the pending one is resolved at once and dropped.
   *
   * A no-op when nothing is focused, which is the common case.
   */
  private snapToRestFraming(): void {
    const goal = this.camRest ?? this.camGoal;
    this.camRest = null;
    this.camGoal = null;
    if (!goal) return;
    this.controls.target.copy(goal.target);
    const dir = this.camera.position.clone().sub(goal.target);
    if (dir.lengthSq() > 1e-8) {
      this.camera.position.copy(goal.target).addScaledVector(dir.normalize(), goal.dist);
    }
    this.controls.update();
  }

  /**
   * The things the explode moves: exactly the components the inspector can select, so the
   * two never disagree about what "a part" is. `explodeWithParent` detail rides its shell,
   * and a named group of anonymous meshes travels whole instead of bursting into slivers.
   * A mesh belonging to no named component falls back to being its own unit, which is what
   * keeps the demos with no naming at all still explodable.
   */
  private explodeUnits(): THREE.Object3D[] {
    const units: THREE.Object3D[] = [];
    const seen = new Set<THREE.Object3D>();
    this.explodeRoot!.traverse((o) => {
      if (!isRealMesh(o) || o.userData.explodeWithParent) return;
      const owner = this.resolveOwner(o) ?? o;
      if (seen.has(owner)) return;
      seen.add(owner);
      units.push(owner);
    });
    return units;
  }

  /**
   * Snapshot each unit's rest position plus the direction it should fly out along.
   *
   * All the maths is done in the ROOT's local frame, not world space, so a demo whose
   * `userData.tick` spins the model does not drag the explode offsets around with it.
   * The offset is then rotated into each unit's own parent frame, so parts nested under
   * a pivot group (a trigger, a wheel, a slide) separate correctly too.
   */
  private prepareExplode(): void {
    const root = this.explodeRoot!;
    root.updateWorldMatrix(true, true);
    this.detachSkinnedUnits();
    const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

    const meshes = this.explodeUnits();

    // Model bounds and each unit's centre, both expressed in root-local coordinates.
    const centres = meshes.map((m) => {
      const box = new THREE.Box3().setFromObject(m);
      return box.getCenter(new THREE.Vector3()).applyMatrix4(rootInv);
    });
    const bounds = new THREE.Box3();
    for (const c of centres) bounds.expandByPoint(c);
    const origin = bounds.getCenter(new THREE.Vector3());
    const span = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(1e-4, bounds.getBoundingSphere(new THREE.Sphere()).radius);

    // Parts stacked concentrically (a barrel inside a slide) have almost no radial direction,
    // so they would stay buried. Push those apart along the model's THINNEST axis instead,
    // which is exactly the axis a layered assembly hides things along.
    const thin = span.x <= span.y && span.x <= span.z ? new THREE.Vector3(1, 0, 0)
      : span.y <= span.z ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);

    /**
     * Expanding the LAYOUT is what separates parts. Displacing every mesh by the same
     * distance — which is what this did before — slides the whole arrangement outward
     * without opening the gaps between neighbours, so parts that touched still touched and
     * were impossible to tell apart or click. Scaling each part's distance from the centre
     * is what actually pulls them apart; the base push then guarantees a visible gap for
     * the parts near the centre, where the scaling term alone is almost nothing.
     */
    const SCALE = 2.1;
    const base = Math.max(radius * 0.3, 0.18);

    const explodedBounds = new THREE.Box3();
    let concentric = 0;

    this.explodeParts = meshes.map((unit, i) => {
      const radial = centres[i].clone().sub(origin);
      let local: THREE.Vector3;
      if (radial.length() < radius * 0.08) {
        // Fan the buried stack out along the thin axis in alternating, growing steps, so
        // three or more concentric parts land as a readable row rather than two piles.
        const rank = concentric++;
        const step = (Math.floor(rank / 2) + 1) * base * 1.4;
        local = thin.clone().multiplyScalar(rank % 2 === 0 ? step : -step);
      } else {
        local = radial.clone().multiplyScalar(SCALE - 1)
          .addScaledVector(radial.clone().normalize(), base);
      }
      explodedBounds.expandByPoint(centres[i].clone().add(local));

      // root-local displacement -> this mesh's parent frame. transformDirection normalises,
      // so the length has to be taken off first and put back afterwards.
      const toParent = new THREE.Matrix4()
        .multiplyMatrices(rootInv, unit.parent!.matrixWorld)
        .invert();
      const len = local.length();
      const offset = local.transformDirection(toParent).multiplyScalar(len);
      return { object: unit, rest: unit.position.clone(), offset };
    });

    // Dolly by how far the layout actually grew rather than by a fixed guess, so a wide
    // spread still lands inside the demo's framing (which has little vertical headroom).
    const grown = explodedBounds.getBoundingSphere(new THREE.Sphere()).radius;
    this.explodeZoom = Math.min(3.4, Math.max(1, grown / radius));
  }

  /**
   * Make a skinned unit's own transform count, so that moving it moves what is drawn.
   *
   * A SkinnedMesh IGNORES ITS OWN MATRIX BY DEFAULT, and this is the reason the explode was a no-op on
   * the rigged character while every number said it had worked: the parts really were 0.4-0.7 m from
   * their rest positions, and the render never changed.
   *
   * In the default `attached` bind mode three.js re-derives `bindMatrixInverse` from `matrixWorld` on
   * every `updateMatrixWorld`, so the vertex ends up at
   *
   *     view * matrixWorld * matrixWorld⁻¹ * bone * bindMatrix
   *
   * and the mesh's own matrix cancels itself out exactly. Skinned vertices follow the BONES and nothing
   * else. `detached` freezes `bindMatrixInverse` at the pose the mesh was bound in, so the cancellation
   * stops and the matrix -- the explode offset included -- applies again.
   *
   * Safe because it changes nothing at rest: at `explodeT === 0` each unit sits back at its bind pose, so
   * `matrixWorld` equals the frozen bind matrix and the two cancel exactly as before. What it does assume
   * is that a skinned unit's world matrix is otherwise the one it was bound in -- true here, where every
   * skinned mesh is a direct child of a static model group with identity rotation and unit scale. A demo
   * that moved its model root, or nested skinned meshes under an animated pivot, would need the offset
   * applied after skinning in the shader instead.
   */
  private detachSkinnedUnits(): void {
    for (const unit of this.explodeUnits()) {
      unit.traverse((o) => {
        const skinned = o as THREE.SkinnedMesh;
        if (skinned.isSkinnedMesh) skinned.bindMode = THREE.DetachedBindMode;
      });
    }
  }

  private applyExplode(): void {
    if (!this.explodeRoot) return;
    if (!this.explodeParts) this.prepareExplode();
    for (const p of this.explodeParts!) {
      p.object.position.copy(p.rest).addScaledVector(p.offset, this.explodeT);
    }
    // Pull the camera back as things come apart, otherwise the outermost parts leave the
    // frame — the demo framings are tight and have almost no vertical headroom. Only while
    // the animation is running, so the viewer keeps free control of zoom once it settles.
    if (this.explodeT !== this.explodeTarget) {
      const dir = this.camera.position.clone().sub(this.controls.target);
      if (dir.lengthSq() > 1e-8) {
        this.camera.position.copy(this.controls.target).addScaledVector(
          dir.normalize(),
          this.explodeBaseDist * (1 + (this.explodeZoom - 1) * this.explodeT),
        );
      }
    }
    // Stays true for the one frame that lands back on 0, so the rest pose is restored
    // before we stop writing positions and hand the parts back to the demo's ticker.
    this.explodeApplied = this.explodeT > 0;
  }

  // ------------------------------------------------------------------ part inspector

  /**
   * Turns the registered model root into a clickable part tree. No-op in capture mode, or
   * before `setExplodeRoot`. Safe on any demo: a model whose meshes are unnamed simply yields
   * an empty `parts` list and never selects anything, rather than selecting nonsense.
   */
  enableInspect(opts: { onSelect?: (sel: PartInfo | null) => void } = {}): void {
    if (this.capture || !this.explodeRoot) return;
    this.inspectRoot = this.explodeRoot;
    this.onSelectCb = opts.onSelect ?? null;
    this.highlightMat = new THREE.MeshBasicMaterial({
      // Deliberately NOT the demo's accent colour: the accent is sampled from the object, so
      // on this crimson Glock a crimson glow was nearly invisible. A cold pale cyan is the
      // one hue no demo in the gallery wears, which is what makes it read as a selection.
      color: new THREE.Color('#6fe3ff'),
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      // The overlay shares the source geometry exactly, so without a depth nudge it z-fights
      // the surface it is meant to tint and the glow breaks up into speckle.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.buildPartList();

    const el = this.renderer.domElement;
    const onDown = (e: PointerEvent) => { this.pickDown = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      const d = this.pickDown;
      this.pickDown = null;
      // An orbit drag ends in a pointerup too; only a near-stationary release is a click.
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.handlePick(e);
    };
    const onMove = (e: PointerEvent) => {
      if (this.pickDown) return; // mid-drag: leave the cursor alone
      el.style.cursor = this.pickAt(e).length ? 'pointer' : '';
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.isolateOn) this.setIsolate(false);
      else this.selectByName(null);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    this.teardown.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
    });
  }

  /** Every selectable component, in model tree order. Empty until `enableInspect`. */
  get parts(): PartInfo[] {
    return this.partList;
  }

  /**
   * Recompute the part list after the model gains geometry.
   *
   * `enableInspect` reads the tree once, synchronously, which is correct for a demo whose `build()`
   * hands back a finished model. A demo that loads an asset cannot do that: `build()` is synchronous
   * by contract, so it returns an EMPTY group and fills it when the file arrives. The list taken from
   * that empty group is not merely stale -- it is shorter than two entries, which the demo page reads
   * as "no part tree" and hides the whole section permanently. The GLB baseline lost its part list
   * exactly this way, and it is the one demo whose parts exist to be compared against.
   */
  rebuildParts(): void {
    if (!this.inspectRoot) return;
    this.buildPartList();
    // The explode units are derived from the same meshes, so a part list that has changed means the
    // cached offsets describe a model that no longer exists. Dropping them forces a recompute on the
    // next explode instead of pulling apart a stale set.
    this.explodeParts = null;
  }

  get selected(): PartInfo | null {
    return this.selection;
  }

  get isolated(): boolean {
    return this.isolateOn;
  }

  /** The demo's own honesty record, when it publishes one under `sculptRuntime`. */
  get provenance(): ProvenanceInfo | null {
    const rt = this.inspectRoot?.userData.sculptRuntime as
      { provenance?: ProvenanceInfo } | undefined;
    return rt?.provenance ?? null;
  }

  selectByName(name: string | null): void {
    this.applySelection(name ? this.partList.find((p) => p.name === name) ?? null : null);
  }

  /** Hide everything except the selected part and frame the camera on it. */
  setIsolate(on: boolean): void {
    if (on && !this.selection) return;
    this.isolateOn = on;
    if (on) this.applyIsolate();
    else this.clearIsolate();
    // The callback reports inspector state, not just selection changes: Escape can turn
    // isolate off without touching the selection, and the UI has to hear about that or its
    // toggle keeps claiming the model is isolated when it is not.
    this.onSelectCb?.(this.selection);
  }

  /**
   * A named Mesh is a part. A named Group is a *container* — `slideAssembly`, `triggerPivot` —
   * and must be descended through, EXCEPT when every mesh under it is integral detail, which
   * is what a serration comb, a cable loom or a two-piece sight looks like: those are one
   * selectable thing. Anything integral is never selectable itself; a click on it walks up.
   */
  private isSelectable(o: THREE.Object3D): boolean {
    if (!o.name || o.userData.explodeWithParent || o.userData.isHighlight) return false;
    if (isRealMesh(o)) return true;
    let hasMesh = false;
    o.traverse((c) => { if (isRealMesh(c)) hasMesh = true; });
    // A named group holding named parts is a container to descend past. A named group whose
    // meshes are anonymous is the part itself — that is how several demos in this gallery are
    // built, and treating them as containers would leave their whole model unselectable.
    return hasMesh && !this.hasSelectableDescendant(o);
  }

  private hasSelectableDescendant(o: THREE.Object3D): boolean {
    return o.children.some((c) => this.isSelectable(c) || this.hasSelectableDescendant(c));
  }

  /**
   * The built part tree as plain data, for the assembly gate
   * (`forge/stage4_review/check_part_coverage.py`). Deliberately available WITHOUT the
   * inspector, so a headless capture run — where picking is switched off — can still dump it.
   */
  partManifest(): {
    parts: Array<Omit<PartInfo, 'object'>>;
    unnamedMeshes: number;
    integralMeshes: number;
  } | null {
    if (!this.explodeRoot) return null;
    if (!this.partList.length) this.buildPartList();
    let unnamedMeshes = 0;
    let integralMeshes = 0;
    this.explodeRoot.traverse((o) => {
      if (!isRealMesh(o)) return;
      if (o.userData.explodeWithParent) integralMeshes++;
      else if (!this.resolveOwner(o)) unnamedMeshes++;
    });
    return {
      parts: this.partList.map((p) => ({
        name: p.name,
        module: p.module,
        kind: p.kind,
        triangles: p.triangles,
        materials: p.materials,
      })),
      unnamedMeshes,
      integralMeshes,
    };
  }

  private buildPartList(): void {
    const root = this.explodeRoot!;
    const rt = root.userData.sculptRuntime as
      { destructionGroups?: Record<string, string[]> } | undefined;
    this.moduleOf.clear();
    for (const [mod, names] of Object.entries(rt?.destructionGroups ?? {})) {
      for (const n of names) this.moduleOf.set(n, mod);
    }
    this.partList = [];
    // Keep descending past a hit: a shell owns detail groups that resolve as their own
    // selection (the serration combs hang off the slide mesh), so stopping here would list
    // fewer parts than a click can actually reach.
    const walk = (o: THREE.Object3D): void => {
      if (o !== root && this.isSelectable(o)) this.partList.push(this.describePart(o));
      for (const c of o.children) walk(c);
    };
    walk(root);
  }

  private describePart(o: THREE.Object3D): PartInfo {
    const meshes: THREE.Mesh[] = [];
    o.traverse((c) => { if (isRealMesh(c)) meshes.push(c); });
    const first = meshes[0];
    // Detail only when every mesh under it is integral relief riding a shell. A group of
    // ordinary meshes is a multi-piece component, not decoration.
    const kind = isRealMesh(o) || meshes.some((m) => !m.userData.explodeWithParent)
      ? 'part' : 'detail';
    const mats = first
      ? (Array.isArray(first.material) ? first.material : [first.material])
      : [];
    return {
      name: o.name,
      module: this.moduleOf.get(o.name) ?? null,
      kind,
      triangles: triangleCount(o),
      materials: [...new Set(mats.map(describeMaterial))],
      object: o,
    };
  }

  /**
   * Walk up from any mesh to the component that owns it — the unit a click selects and the
   * unit the explode moves. Bounded by the model root, so it never escapes into the scene.
   */
  private resolveOwner(hit: THREE.Object3D): THREE.Object3D | null {
    let n: THREE.Object3D | null = hit;
    while (n && n !== this.explodeRoot) {
      if (this.isSelectable(n)) return n;
      n = n.parent;
    }
    return null;
  }

  /** Components under the pointer, front to back, deduped. */
  private pickAt(e: PointerEvent): THREE.Object3D[] {
    if (!this.inspectRoot) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const out: THREE.Object3D[] = [];
    for (const hit of this.raycaster.intersectObject(this.inspectRoot, true)) {
      if (hit.object.userData.isHighlight || !this.visibleUpTo(hit.object)) continue;
      const node = this.resolveOwner(hit.object);
      if (node && !out.includes(node)) out.push(node);
    }
    return out;
  }

  private visibleUpTo(o: THREE.Object3D): boolean {
    let n: THREE.Object3D | null = o;
    while (n && n !== this.inspectRoot) {
      if (!n.visible) return false;
      n = n.parent;
    }
    return true;
  }

  /**
   * Click resolution. The frame is translucent, so the parts you can SEE through the polymer
   * are exactly the ones a nearest-hit raycast can never reach. Clicking the same spot again
   * steps to the next component along the same ray, which walks you inward: frame → cyber
   * module → magazine spine.
   */
  private handlePick(e: PointerEvent): void {
    const hits = this.pickAt(e);
    if (!hits.length) {
      this.selectByName(null);
      return;
    }
    const key = hits.map((h) => h.name).join('>');
    this.pickIndex = key === this.pickKey ? (this.pickIndex + 1) % hits.length : 0;
    this.pickKey = key;
    this.applySelection(this.describePart(hits[this.pickIndex]));
  }

  private applySelection(part: PartInfo | null): void {
    this.clearHighlight();
    this.selection = part;
    if (part) this.addHighlight(part.object);
    if (this.isolateOn) {
      if (part) this.applyIsolate();
      else this.setIsolate(false);
    }
    this.onSelectCb?.(part);
  }

  private addHighlight(node: THREE.Object3D): void {
    if (!this.highlightMat) return;
    const targets: THREE.Mesh[] = [];
    node.traverse((c) => { if (isRealMesh(c)) targets.push(c); });
    for (const t of targets) {
      const glow = new THREE.Mesh(t.geometry, this.highlightMat);
      glow.userData.isHighlight = true;
      // Never an explode part and never pickable — it is a tint, not geometry.
      glow.userData.explodeWithParent = true;
      glow.renderOrder = 999;
      t.add(glow);
      this.highlightMeshes.push(glow);
    }
  }

  private clearHighlight(): void {
    for (const g of this.highlightMeshes) g.removeFromParent();
    this.highlightMeshes.length = 0;
  }

  private applyIsolate(): void {
    this.restoreHidden();
    const keep = new Set<THREE.Object3D>();
    this.selection!.object.traverse((o) => keep.add(o));
    this.inspectRoot!.traverse((o) => {
      if (!isRealMesh(o) || keep.has(o) || !o.visible) return;
      o.visible = false;
      this.hiddenByIsolate.push(o);
    });
    this.focusOn(this.selection!.object);
  }

  private clearIsolate(): void {
    this.restoreHidden();
    if (this.camRest) {
      this.camGoal = this.camRest;
      this.camRest = null;
    }
  }

  private restoreHidden(): void {
    for (const m of this.hiddenByIsolate) m.visible = true;
    this.hiddenByIsolate.length = 0;
  }

  /** Ease the camera onto a part's bounding sphere. Remembers the pose to come back to. */
  private focusOn(node: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    if (!this.camRest) {
      this.camRest = {
        target: this.controls.target.clone(),
        dist: this.camera.position.distanceTo(this.controls.target),
      };
    }
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    this.camGoal = {
      target: box.getCenter(new THREE.Vector3()),
      dist: (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 2.2,
    };
  }

  private easeCamera(dt: number): void {
    const goal = this.camGoal;
    if (!goal) return;
    const k = 1 - Math.pow(0.002, dt);
    this.controls.target.lerp(goal.target, k);
    const dir = this.camera.position.clone().sub(this.controls.target);
    const d = dir.length();
    if (d < 1e-6) return;
    const next = d + (goal.dist - d) * k;
    this.camera.position.copy(this.controls.target).addScaledVector(dir.divideScalar(d), next);
    if (this.controls.target.distanceTo(goal.target) < 1e-3 && Math.abs(next - goal.dist) < 1e-3) {
      this.camGoal = null;
    }
  }

  private handleResize(): void {
    const width = this.mount.clientWidth || window.innerWidth;
    const height = this.mount.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.applyFit();
  }

  /**
   * Makes the framing responsive: measures `object` around the orbit target and dollies the
   * camera back far enough that it fits the current viewport on both axes. On a desktop-shaped
   * viewport the authored distance already fits, so nothing moves; in portrait — where the
   * horizontal fov collapses and the subject would fall outside the frame — the camera pulls
   * back. Call once, AFTER the demo's build(). Re-applied automatically on resize/rotate.
   */
  fitToViewport(object: THREE.Object3D | THREE.Object3D[]): void {
    // Capture mode owns its own deterministic framing (frameForCapture) — leave it alone.
    if (this.capture) return;
    const objects = Array.isArray(object) ? object : [object];
    this.fitExtent = subjectExtent(objects, this.controls.target);
    const fog = this.scene.fog;
    this.fogBase = fog instanceof THREE.Fog ? { near: fog.near, far: fog.far } : null;
    this.applyFit();
  }

  private applyFit(): void {
    if (!this.fitExtent || this.authoredDistance <= 0) return;

    const scale = fitScale(
      this.fitExtent,
      this.camera.fov,
      this.camera.aspect,
      this.authoredDistance,
    );
    const desired = this.authoredDistance * scale;
    if (this.appliedDistance && Math.abs(desired - this.appliedDistance) < 1e-3) return;

    // The camera distance is only the viewer's to keep when nothing else is driving it. While an
    // explode or a part-focus is running, that system owns the distance, and reading it back here
    // would fold its dolly (up to 3.4x) into the framing and leave the camera stranded once the
    // animation settles. In that case leave the position alone and just re-base the other owners.
    const driven = this.explodeT > 0 || this.explodeTarget > 0 || this.camGoal !== null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    // Keep whatever zoom the user dialled in, expressed relative to the last fit distance.
    const userZoom = !driven && this.appliedDistance
      ? (offset.length() || 1) / this.appliedDistance
      : 1;
    const distance = desired * userZoom;
    if (!driven) {
      offset.setLength(distance);
      this.camera.position.copy(this.controls.target).add(offset);
    }

    // Re-base the other camera-distance owners onto the new framing, so an explode or a focus
    // that starts (or is mid-flight) across a resize dollies from the right distance instead of
    // snapping back to the pre-resize one.
    const framingRatio = this.appliedDistance ? desired / this.appliedDistance : 1;
    if (framingRatio !== 1) {
      this.explodeBaseDist *= framingRatio;
      if (this.camRest) this.camRest.dist *= framingRatio;
      if (this.camGoal) this.camGoal.dist *= framingRatio;
    }
    this.appliedDistance = desired;

    // A dollied-back camera can push the subject past the authored far plane, and past a
    // demo's fog range (which would fade it to nothing) — scale both with the pull-back.
    const reach = Math.max(this.fitExtent.horizontal, this.fitExtent.vertical);
    this.camera.far = Math.max(this.authoredFar, distance + reach * 6);
    this.camera.updateProjectionMatrix();
    if (this.fogBase && this.scene.fog instanceof THREE.Fog) {
      const k = distance / this.authoredDistance;
      this.scene.fog.near = this.fogBase.near * k;
      this.scene.fog.far = this.fogBase.far * k;
    }
    this.controls.update();
  }

  /**
   * Advance the orbit by `dt` worth of rotation.
   *
   * The camera swings about the vertical through the controls' target, and OrbitControls is left to pick
   * the new position up on its own `update()` -- it derives its spherical coordinates from the camera on
   * every call, so moving the camera first is the whole of it, and its damping still smooths a drag.
   */
  private spinTurntable(dt: number): void {
    const step = Math.min(dt, TURNTABLE_MAX_STEP_S);
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(TURNTABLE_AXIS, (this.turntableRate * Math.PI) / 180 * step);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
  }

  /** Whether the turntable is switched on. Stays true across the pause a drag causes. */
  get turntable(): boolean {
    return this.turntableWanted;
  }

  /** Turn the camera turntable on or off. A no-op in capture mode, which must stay deterministic. */
  setTurntable(on: boolean): void {
    this.turntableWanted = on && !this.capture;
    this.turntableResume = 0;
    this.turntableSpinning = this.turntableWanted;
  }

  start(): void {
    const clock = new THREE.Clock();
    this.refreshTickers();

    const loop = (): void => {
      this.rafHandle = requestAnimationFrame(loop);
      const dt = clock.getDelta();
      const elapsed = clock.getElapsedTime();
      // Review captures must freeze the authored idle pose so repeated screenshots
      // compare the same pixels. The runtime hook remains active in the live viewer.
      if (!this.capture) {
        for (const tick of this.tickers) tick(dt, elapsed);
      }
      // Ease toward the explode target, then hold the pose. Runs AFTER the demo tickers so
      // that on a demo which animates part positions (a rising lid, a turning crank) the
      // explode offset wins while separated, and the ticker gets its parts back the frame
      // after we settle at 0.
      if (this.explodeT !== this.explodeTarget) {
        const k = 1 - Math.pow(0.001, dt); // frame-rate-independent exponential ease
        this.explodeT += (this.explodeTarget - this.explodeT) * k;
        if (Math.abs(this.explodeTarget - this.explodeT) < 0.001) this.explodeT = this.explodeTarget;
      }
      if (this.explodeT > 0 || this.explodeApplied) this.applyExplode();
      this.easeCamera(dt);
      if (this.turntableResume > 0) {
        this.turntableResume -= dt;
        if (this.turntableResume <= 0) {
          this.turntableResume = 0;
          this.turntableSpinning = this.turntableWanted;
        }
      }
      // Ahead of `controls.update()`, which is what reads the moved camera back.
      if (this.turntableSpinning) this.spinTurntable(dt);
      /**
       * PUBLISHED FOR THE DEMOS, in degrees per second and 0 when the orbit is not running.
       *
       * A demo cannot see the turntable otherwise -- it is a property of the camera, and the camera is the
       * viewer's. Cloth and hair on this character are asked to react to the turn, so the one number they
       * need is put somewhere they can read it. A plain number and not an object: this runs every frame.
       */
      (this.scene.userData as { turntableRate?: number }).turntableRate =
        this.turntableSpinning ? this.turntableRate : 0;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();

    // Headless-evaluation ready-signal: wait for async texture loads (DefaultLoadingManager),
    // then a few frames so shaders compile + buffers flip, then flag the page as capture-ready.
    // Fixes the load-race that produced false "chrome"/white renders. No-op for normal viewing
    // beyond setting a window flag. See grimoire/feedback/render_capture.md.
    const w = window as unknown as { __IMG2THREEJS_READY__?: boolean };
    w.__IMG2THREEJS_READY__ = false;
    let signalled = false;
    const signalReady = (): void => {
      if (signalled) return;
      signalled = true;
      let framesToWait = 6;
      const pump = (): void => {
        if (framesToWait-- > 0) {
          requestAnimationFrame(pump);
          return;
        }
        w.__IMG2THREEJS_READY__ = true;
      };
      pump();
    };
    THREE.DefaultLoadingManager.onLoad = signalReady;
    // Fallback: if no async loads are pending, onLoad never fires → kick after a short delay.
    setTimeout(signalReady, 600);
  }

  /**
   * Capture-mode auto-framing: place the camera side-on (looking down +Z at the model's
   * bounding-box centre) at a distance that fits the object, matching a side-on reference plate.
   * Call AFTER the demo's build() so the model exists. Near-ortho fov reduces perspective skew.
   */
  frameForCapture(fovDeg = 20, margin = 1.12, side: 1 | -1 = 1, targetOffsetY = 0): void {
    const box = new THREE.Box3();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) box.expandByObject(mesh);
    });
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    center.y += size.y * targetOffsetY;
    this.camera.fov = fovDeg;
    const vFov = (fovDeg * Math.PI) / 180;
    const halfH = size.y / 2;
    const halfW = size.x / 2;
    const aspect = this.camera.aspect || 1;
    const distH = halfH / Math.tan(vFov / 2);
    const distW = halfW / Math.tan(vFov / 2) / aspect;
    const dist = Math.max(distH, distW) * margin + size.z / 2;
    this.camera.position.set(center.x, center.y, center.z + dist * side);
    this.camera.near = Math.max(0.01, dist - size.z);
    this.camera.far = dist + size.z * 4;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Capture framing pinned to explicit numbers. Nothing here reads the scene, so a geometry change
   * cannot reframe the shot — which is what makes a silhouette metric comparable between passes.
   * frameForCapture() derives distance and target from the bounding box of the very geometry under
   * review, so growing a sub-assembly pulls the camera back and shrinks the whole silhouette.
   */
  pinCaptureCamera(cam: PinnedCaptureCamera): void {
    this.camera.fov = cam.fov;
    this.camera.near = cam.near;
    this.camera.far = cam.far;
    this.camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
    this.camera.updateProjectionMatrix();
    const target = new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Frees renderer/GPU resources. Call this before swapping to a new demo. */
  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    window.removeEventListener('resize', this.onResize);
    for (const off of this.teardown) off();
    this.teardown.length = 0;
    // Overlay clones share their source geometry, so drop them before the sweep below or it
    // disposes the same buffers twice.
    this.clearHighlight();
    this.restoreHidden();
    this.highlightMat?.dispose();
    this.controls.dispose();

    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (material) {
        const materials = Array.isArray(material) ? material : [material];
        for (const mat of materials) {
          disposeMaterialTextures(mat);
          mat.dispose();
        }
      }
    });

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.mount) {
      this.mount.removeChild(this.renderer.domElement);
    }
  }
}

function disposeMaterialTextures(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value instanceof THREE.Texture) {
      value.dispose();
    }
  }
}

function installDefaultStudioLights(scene: THREE.Scene): void {
  const key = new THREE.DirectionalLight(0xfff6e8, 2.2);
  key.position.set(-2.4, 3.2, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 12;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.35);
  fill.position.set(2.8, 0.8, 1.6);
  scene.add(fill);

  const hemi = new THREE.HemisphereLight(0xbfd0ff, 0x20263a, 0.35);
  scene.add(hemi);
}
