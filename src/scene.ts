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
}

/** An explicit review camera: geometry-independent, so a pass is measured rather than reframed. */
export interface PinnedCaptureCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

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

  private readonly mount: HTMLElement;
  private rafHandle = 0;
  private readonly onResize: () => void;
  private readonly capture: boolean;

  private explodeRoot: THREE.Object3D | null = null;
  private explodeParts: Array<{ object: THREE.Object3D; rest: THREE.Vector3; offset: THREE.Vector3 }> | null = null;
  private explodeT = 0;
  private explodeTarget = 0;
  private explodeApplied = false;
  private explodeBaseDist = 0;
  /** How much the layout grows when fully separated — drives the camera dolly. */
  private explodeZoom = 1;

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
    if (this.capture) {
      // Flat white studio bg matches the reference photos (white-bg) → fair silhouette IoU.
      // Mask captures intentionally leave the clear color transparent for
      // alpha-based foreground extraction; they are diagnostic evidence only.
      this.scene.background = maskCapture ? null : new THREE.Color(0xffffff);
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

  /** True once a root with more than one mesh is registered, i.e. worth offering the control. */
  get canExplode(): boolean {
    if (!this.explodeRoot) return false;
    let n = 0;
    this.explodeRoot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    return n > 1;
  }

  /** 0 = assembled, 1 = fully separated. The render loop eases toward this. */
  setExplode(t: number): void {
    const next = Math.max(0, Math.min(1, t));
    // Capture the framing distance the moment we leave the assembled pose, so the dolly
    // below has a stable base even if the viewer zoomed since the last explode.
    if (this.explodeT === 0 && next > 0) {
      this.explodeBaseDist = this.camera.position.distanceTo(this.controls.target);
    }
    this.explodeTarget = next;
  }

  /**
   * The things the explode moves: exactly the components the inspector can select, so the
   * two never disagree about what "a part" is. `explodeWithParent` detail rides its shell,
   * and a named group of anonymous meshes travels whole instead of bursting into slivers.
   * A mesh belonging to no named component falls back to being its own unit, which is what
   * keeps the demos with no naming at all still explodable.
   */
  private explodeUnits(): THREE.Object3D[] {
    // Use the same selectable component tree exposed by the Parts inspector when
    // one exists. Some procedural models intentionally mark every child mesh as
    // integral detail (`explodeWithParent`) while the named component groups are
    // still the correct units to separate.
    if (!this.partList.length) this.buildPartList();
    if (this.partList.length) return this.partList.map((part) => part.object);

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

  start(): void {
    const clock = new THREE.Clock();
    // Collect per-frame updaters exposed by demos via `object.userData.tick`.
    const tickers: Array<(dt: number, elapsed: number) => void> = [];
    this.scene.traverse((object) => {
      const tick = (object.userData as { tick?: unknown }).tick;
      if (typeof tick === 'function') {
        tickers.push(tick as (dt: number, elapsed: number) => void);
      }
    });

    const loop = (): void => {
      this.rafHandle = requestAnimationFrame(loop);
      const dt = clock.getDelta();
      const elapsed = clock.getElapsedTime();
      // Review captures must freeze the authored idle pose so repeated screenshots
      // compare the same pixels. The runtime hook remains active in the live viewer.
      if (!this.capture) {
        for (const tick of tickers) tick(dt, elapsed);
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
