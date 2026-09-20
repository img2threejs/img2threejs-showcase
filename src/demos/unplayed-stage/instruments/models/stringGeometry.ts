import * as THREE from 'three';

/**
 * The two plucked instruments share the same small, editable string rig.
 * Geometry is allocated once; animation only updates a preallocated position
 * buffer. This keeps the visible string count and the runtime animation
 * contract independent from any imported mesh.
 */
export interface ProceduralStringModel {
  readonly root: THREE.Group;
  readonly components: Map<string, THREE.Object3D>;
  readonly strings: THREE.Object3D[];
  readonly fretActuators: THREE.Object3D[];
  readonly picks: THREE.Object3D[];
  fretPosition(stringIndex: number, fret: number): THREE.Vector3;
  setStringVibration(stringIndex: number, amplitude: number, phase: number): void;
}

interface VibrationState {
  readonly basePositions: Float32Array;
  readonly segmentCount: number;
  readonly radialSegments: number;
  /** Primary displacement axis retained for the original inspection contract. */
  readonly axis: THREE.Vector3;
  /** A second transverse axis makes the pluck read in the front camera. */
  readonly secondaryAxis: THREE.Vector3;
  readonly wavePlane: 'XZ';
  readonly pinnedEndpoints: true;
  readonly activeLength: 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function animationRoleFor(componentId: string): string {
  if (componentId === 'root' || componentId.endsWith('.root')) return 'root';
  if (componentId.includes('.string.')) return 'string-vibration';
  if (componentId.includes('.fret-actuator.')) return 'fret-actuator';
  if (componentId.includes('.pick.')) return 'pick-pluck';
  if (componentId.includes('.stand')) return 'support';
  return 'static-part';
}

/**
 * Create a low-poly swept tube along a string path. The path is sampled by
 * TubeGeometry once and then copied into a stable buffer for local vibration.
 */
export function createVibratingString(
  name: string,
  points: readonly THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  segments = 44,
  radialSegments = 5,
): THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
  const curve = new THREE.CatmullRomCurve3(
    points.map((point) => point.clone()),
    false,
    'centripetal',
    0.5,
  );
  const geometry = new THREE.TubeGeometry(
    curve,
    segments,
    radius,
    radialSegments,
    false,
  );
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const basePositions = new Float32Array(position.array as ArrayLike<number>);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.vibration = {
    basePositions,
    segmentCount: segments,
    radialSegments,
    // The reference instruments are front-facing. Keep the original shallow
    // Z displacement, then add a smaller X component so the wave remains
    // legible from the front without becoming a ribbon or a flashing stripe.
    axis: new THREE.Vector3(0, 0, 1),
    secondaryAxis: new THREE.Vector3(1, 0, 0),
    wavePlane: 'XZ',
    pinnedEndpoints: true,
    activeLength: 1,
  } satisfies VibrationState;
  const start = points[0];
  const end = points[points.length - 1];
  if (start && end) {
    mesh.userData.endpoints = {
      start: start.toArray(),
      end: end.toArray(),
      pinned: true,
    };
  }
  return mesh;
}

/**
 * Update one string's position buffer. End rings remain fixed at the nut and
 * bridge; the interior uses a smooth envelope and two visible wave cycles.
 */
export function setStringVibration(
  stringObject: THREE.Object3D,
  amplitude: number,
  phase: number,
): void {
  const mesh = stringObject as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  const state = mesh.userData.vibration as VibrationState | undefined;
  if (!state || !mesh.geometry) return;
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  const { basePositions, segmentCount, radialSegments, axis, secondaryAxis } = state;
  const safeAmplitude = Number.isFinite(amplitude) ? Math.max(0, amplitude) : 0;
  const safePhase = Number.isFinite(phase) ? phase : 0;
  // PerformanceRig writes this normalized fraction before each call. It is
  // deliberately stored on userData rather than rebuilding the tube so a
  // fretted note can stop at the actual fret while the remaining string stays
  // visually still. Direct callers and the model preview use the full length.
  const activeLength = clamp(
    Number.isFinite(mesh.userData.vibrationActiveLength)
      ? Number(mesh.userData.vibrationActiveLength)
      : 1,
    0.16,
    1,
  );
  const waveCycles = clamp(
    Number.isFinite(mesh.userData.vibrationWaveCycles)
      ? Number(mesh.userData.vibrationWaveCycles)
      : 2.15,
    1.25,
    4.5,
  );
  const verticesPerRing = radialSegments + 1;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const ring = Math.floor(vertex / verticesPerRing);
    const u = clamp(ring / segmentCount, 0, 1);
    // Keep both the bridge and the active fret contact still. The segment
    // above the fret is intentionally quiet, which keeps fretted notes from
    // vibrating through a finger position while retaining a pinned nut.
    const activeU = clamp(u / activeLength, 0, 1);
    const envelope = u <= activeLength
      ? Math.pow(Math.sin(Math.PI * activeU), 0.76)
      : 0;
    const primary = Math.sin(safePhase + activeU * Math.PI * 2 * waveCycles);
    const secondary = Math.cos(safePhase * 0.73 + activeU * Math.PI * 2 * (waveCycles + 0.35));
    const primaryWave = primary * safeAmplitude * envelope;
    const secondaryWave = secondary * safeAmplitude * 0.42 * envelope;
    const offset = vertex * 3;
    array[offset] = basePositions[offset] + axis.x * primaryWave + secondaryAxis.x * secondaryWave;
    array[offset + 1] = basePositions[offset + 1] + axis.y * primaryWave + secondaryAxis.y * secondaryWave;
    array[offset + 2] = basePositions[offset + 2] + axis.z * primaryWave + secondaryAxis.z * secondaryWave;
  }
  position.needsUpdate = true;
}

export function markComponent(
  object: THREE.Object3D,
  componentId: string,
  pivot: THREE.Object3D = object,
): void {
  object.userData.componentId = componentId;
  object.userData.pivot = pivot;
  // Keep the small procedural hierarchy self-describing.  The final asset
  // contract treats every addressable part as an action-ready component;
  // these fields make that contract available to pickers and review probes
  // without requiring a second registry beside `components`.
  object.userData.assetSource = 'procedural';
  object.userData.actionReady = true;
  object.userData.animationRole = animationRoleFor(componentId);
  object.userData.actionProfile = {
    animationRole: object.userData.animationRole,
    pivot,
  };
  object.userData.parentComponentId = object.parent?.userData.componentId;
}

export function addComponent(
  components: Map<string, THREE.Object3D>,
  object: THREE.Object3D,
  componentId: string,
  pivot: THREE.Object3D = object,
): void {
  markComponent(object, componentId, pivot);
  components.set(componentId, object);
}

export function setShadowFlags(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
}
