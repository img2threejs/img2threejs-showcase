import * as THREE from 'three';

import type { NoteEvent, Score, TrackId } from '../music/ScoreLoader';
import { evaluatePianoKeyPoseAtTime, evaluateSustainValue } from './pose';

export interface KickBeaterContact {
  readonly restRotationX: number;
  readonly contactRotationX: number;
}

export interface PianoModel {
  root: THREE.Group;
  components: Map<string, THREE.Object3D>;
  keyPivots: Map<number, THREE.Group>;
  sustainPedal: THREE.Object3D;
  /** Optional model-owned lid/action mechanics. The generic key map stays in the rig. */
  applyMechanics?: (timeSeconds: number, reducedMotion: boolean) => void;
}

export interface StringModel {
  root: THREE.Group;
  components: Map<string, THREE.Object3D>;
  strings: THREE.Object3D[];
  fretActuators: THREE.Object3D[];
  picks: THREE.Object3D[];
  fretPosition(stringIndex: number, fret: number): THREE.Vector3;
  setStringVibration(stringIndex: number, amplitude: number, phase: number): void;
}

export interface DrumModel {
  root: THREE.Group;
  components: Map<string, THREE.Object3D>;
  hitAnchors: Map<string, THREE.Vector3>;
  sticks: Map<'left' | 'right', THREE.Group>;
  kickBeater: THREE.Object3D;
  cymbals: Map<string, THREE.Object3D>;
  /** Angles are measured against the model's authored kick pivot. */
  kickBeaterContact?: KickBeaterContact;
  /** Optional model-owned pedal, beater and hardware mechanics. */
  applyMechanics?: (
    timeSeconds: number,
    notes: readonly NoteEvent[],
    reducedMotion: boolean,
  ) => void;
}

export interface PerformanceModels {
  piano: PianoModel;
  guitar: StringModel;
  bass: StringModel;
  drums: DrumModel;
}

export interface TrackEnvelope {
  piano: number;
  guitar: number;
  bass: number;
  drums: number;
}

export interface PerformanceRig {
  readonly root: THREE.Group;
  readonly instrumentGroups: Record<TrackId, THREE.Group>;
  readonly components: Map<string, THREE.Object3D>;
  readonly models: PerformanceModels;
  apply(timeSeconds: number, reducedMotion?: boolean): void;
  getTrackEnvelope(timeSeconds: number): TrackEnvelope;
  setAudibleTracks(trackIds: readonly TrackId[]): void;
  getAudibleTracks(): readonly TrackId[];
  dispose(): void;
}

const smooth = (value: number): number => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};

const ids: TrackId[] = ['piano', 'guitar', 'bass', 'drums'];
const stringIds = ['guitar', 'bass'] as const;
const TAU = Math.PI * 2;
const STRING_PEAK_AMPLITUDE = 0.008;
const STRING_RELEASE_TAIL_SECONDS = 0.72;

/** Absolute event lookup: a seek needs no previous animation frames. */
export function neighboringEvents(events: readonly NoteEvent[], time: number): {
  previous: NoteEvent | undefined;
  next: NoteEvent | undefined;
} {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.onsetSeconds <= time) low = middle + 1;
    else high = middle;
  }
  return { previous: events[low - 1], next: events[low] };
}

/** The stick tip follows a continuous arch between two actual impact anchors. */
export function strokeTip(
  time: number,
  events: readonly NoteEvent[],
  anchors: Map<string, THREE.Vector3>,
  rest: THREE.Vector3,
  reducedMotion = false,
): THREE.Vector3 {
  const { previous, next } = neighboringEvents(events, time);
  const previousAnchor = previous && anchors.get(previous.componentId);
  const nextAnchor = next && anchors.get(next.componentId);
  const archHeight = reducedMotion ? 0 : 0.25;
  if (previousAnchor && nextAnchor && previous && next) {
    const denominator = Math.max(0.0001, next.onsetSeconds - previous.onsetSeconds);
    const progress = (time - previous.onsetSeconds) / denominator;
    return previousAnchor
      .clone()
      .lerp(nextAnchor, smooth(progress))
      .add(new THREE.Vector3(0, Math.sin(Math.PI * smooth(progress)) * archHeight, 0));
  }
  if (nextAnchor && next) {
    const progress = smooth((time - (next.onsetSeconds - 0.12)) / 0.12);
    return nextAnchor.clone().add(new THREE.Vector3(0, archHeight * (1 - progress), 0));
  }
  if (previousAnchor && previous) {
    return previousAnchor
      .clone()
      .add(new THREE.Vector3(0, archHeight * smooth((time - previous.onsetSeconds) / 0.22), 0));
  }
  return rest.clone();
}

function safeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function noteLevel(note: NoteEvent, time: number): number {
  const age = time - note.onsetSeconds;
  if (age < 0) return 0;
  const attack = 0.55 + 0.45 * smooth(age / 0.024);
  if (time <= note.releaseSeconds) return note.velocity * attack;
  const releaseAge = time - note.releaseSeconds;
  if (releaseAge > STRING_RELEASE_TAIL_SECONDS) return 0;
  return note.velocity * attack * Math.exp(-7.5 * releaseAge);
}

function evaluateTrackEnvelope(events: readonly NoteEvent[], time: number): number {
  if (!events.length || !Number.isFinite(time)) return 0;
  const { previous } = neighboringEvents(events, time);
  if (!previous) return 0;

  // Notes can overlap on piano and drums. Walk only the short audible tail
  // around the current event and keep the strongest real event envelope.
  let index = events.indexOf(previous);
  let level = 0;
  while (index >= 0) {
    const event = events[index]!;
    if (time - event.onsetSeconds > STRING_RELEASE_TAIL_SECONDS) break;
    level = Math.max(level, noteLevel(event, time));
    index -= 1;
  }
  return Math.max(0, Math.min(1, level));
}

function activeStringLength(
  string: THREE.Object3D,
  fretPoint: THREE.Vector3,
): number {
  const endpoints = string.userData.endpoints as
    | { start?: readonly number[]; end?: readonly number[] }
    | undefined;
  if (!endpoints?.start || !endpoints.end || endpoints.start.length < 3 || endpoints.end.length < 3) {
    return 1;
  }
  const bridge = new THREE.Vector3().fromArray(endpoints.start);
  const nut = new THREE.Vector3().fromArray(endpoints.end);
  const fullLength = bridge.distanceTo(nut);
  if (fullLength <= 0.0001) return 1;
  // The model paths run from bridge to nut; fretPosition returns the contact
  // node on that same path. A small lower bound avoids a zero-length wave at
  // the highest playable fret while leaving the bridge and fret endpoints pinned.
  return THREE.MathUtils.clamp(bridge.distanceTo(fretPoint) / fullLength, 0.16, 1);
}

function setStringState(
  model: StringModel,
  stringIndex: number,
  note: NoteEvent | undefined,
  time: number,
  fret: number,
  reducedMotion: boolean,
): void {
  const string = model.strings[stringIndex];
  if (!string) return;
  const age = note ? time - note.onsetSeconds : Number.POSITIVE_INFINITY;
  const active = note && age >= 0 && age <= STRING_RELEASE_TAIL_SECONDS;
  const fretPoint = model.fretPosition(stringIndex, fret);
  const activeLength = activeStringLength(string, fretPoint);
  string.userData.vibrationActiveLength = activeLength;
  string.userData.vibrationWaveCycles = THREE.MathUtils.clamp(
    1.8 + (1 - activeLength) * 1.1,
    1.8,
    3.0,
  );

  if (!active || !note) {
    model.setStringVibration(stringIndex, 0, 0);
    return;
  }

  const releaseAge = Math.max(0, time - note.releaseSeconds);
  const decay = Math.exp(-1.8 * Math.max(0, age)) * Math.exp(-8.5 * releaseAge);
  // Keep a clear onset impulse while the exponential tail settles naturally.
  // Reduced motion retains the note mapping but lowers the geometric excursion.
  const attack = 0.62 + 0.38 * smooth(age / 0.025);
  const motionScale = reducedMotion ? 0.28 : 1;
  const amplitude = STRING_PEAK_AMPLITUDE * note.velocity * attack * decay * motionScale;
  // A shorter fretted length carries a quicker visual cycle. The rate stays in
  // a readable range rather than attempting to reproduce audio-rate vibration.
  const frequency = THREE.MathUtils.clamp(16 / activeLength, 16, 48);
  const phase = Math.max(0, age) * TAU * frequency;
  model.setStringVibration(stringIndex, amplitude, phase);
}

function contactAngles(model: DrumModel): KickBeaterContact {
  const fallback = { restRotationX: 0.22, contactRotationX: -0.139 } as const;
  const candidate = model.kickBeaterContact;
  if (!candidate) return fallback;
  const restRotationX = safeFinite(candidate.restRotationX, fallback.restRotationX);
  const contactRotationX = safeFinite(candidate.contactRotationX, fallback.contactRotationX);
  return { restRotationX, contactRotationX };
}

export function createPerformanceRig(score: Score, models: PerformanceModels): PerformanceRig {
  const root = new THREE.Group();
  root.name = 'performance.instruments';
  const instrumentGroups = {} as Record<TrackId, THREE.Group>;
  const components = new Map<string, THREE.Object3D>();

  for (const id of ids) {
    const model = models[id];
    model.root.userData.instrumentId = id;
    instrumentGroups[id] = model.root;
    root.add(model.root);
    for (const [key, value] of model.components) components.set(key, value);
  }
  for (const event of score.notes) {
    if (!components.has(event.componentId)) {
      throw new Error(`No performance component for ${event.id}: ${event.componentId}`);
    }
  }
  for (const event of score.controllers) {
    if (event.componentId && !components.has(event.componentId)) {
      throw new Error(`No controller component: ${event.componentId}`);
    }
  }

  const byPart = new Map<string, NoteEvent[]>();
  const byTrack = new Map<TrackId, NoteEvent[]>(ids.map((id) => [id, []]));
  for (const note of score.notes) {
    const part = byPart.get(note.componentId) ?? [];
    part.push(note);
    byPart.set(note.componentId, part);
    byTrack.get(note.instrumentId)!.push(note);
  }

  const keyRest = new Map(
    [...models.piano.keyPivots].map(([pitch, pivot]) => [pitch, pivot.rotation.x]),
  );
  const pedalRest = models.piano.sustainPedal.rotation.x;
  const picksRest = new Map<THREE.Object3D, number>();
  const pickContactZ = new Map<THREE.Object3D, number>();
  for (const id of stringIds) {
    for (const pick of models[id].picks) {
      picksRest.set(pick, pick.rotation.z);
      pickContactZ.set(pick, pick.position.z);
    }
  }
  const stickEvents = new Map<'left' | 'right', NoteEvent[]>([
    ['left', score.notes.filter((note) => note.instrumentId === 'drums' && note.stickId === 'left')],
    ['right', score.notes.filter((note) => note.instrumentId === 'drums' && note.stickId === 'right')],
  ]);
  const cymbalRest = new Map(
    [...models.drums.cymbals].map(([id, object]) => [id, object.rotation.z]),
  );
  const kickAngles = contactAngles(models.drums);
  const hasModelDrumMechanics = typeof models.drums.applyMechanics === 'function';
  let audibleTracks = new Set<TrackId>(ids);
  let disposed = false;

  function apply(timeSeconds: number, reducedMotion = false): void {
    if (disposed) return;
    const time = Number.isFinite(timeSeconds)
      ? THREE.MathUtils.clamp(timeSeconds, 0, score.durationSeconds)
      : 0;

    // Run model-owned mechanics first so dynamic hit anchors and pedal/linkage
    // transforms are current when the generic score pose evaluates contacts.
    models.piano.applyMechanics?.(time, reducedMotion);
    models.drums.applyMechanics?.(time, score.notes, reducedMotion);

    for (const [pitch, pivot] of models.piano.keyPivots) {
      pivot.rotation.x =
        keyRest.get(pitch)! +
        0.055 * evaluatePianoKeyPoseAtTime(time, byPart.get(`piano.key.${pitch}`) ?? []).depression;
    }
    models.piano.sustainPedal.rotation.x =
      pedalRest + 0.13 * evaluateSustainValue(time, score.controllers);

    for (const id of stringIds) {
      const model = models[id];
      for (let index = 0; index < model.strings.length; index += 1) {
        const notes = byPart.get(`${id}.string.${index}`) ?? [];
        const { previous, next } = neighboringEvents(notes, time);
        const preparation = next && time >= next.onsetSeconds - 0.1 ? next : undefined;
        const currentFret = previous?.fret ?? 0;
        const targetFret = preparation?.fret ?? currentFret;
        const fretPosition = model.fretPosition(index, currentFret);
        if (preparation) {
          fretPosition.lerp(
            model.fretPosition(index, targetFret),
            smooth((time - (preparation.onsetSeconds - 0.1)) / 0.1),
          );
        }
        if (model.fretActuators[index]) {
          model.fretActuators[index].position.copy(fretPosition);
          model.fretActuators[index].position.z -=
            previous && time < previous.releaseSeconds ? 0.0025 : 0;
        }
        // The active length follows the currently fretted node, while note
        // identity and onset still come from the absolute score event.
        setStringState(model, index, previous, time, currentFret, reducedMotion);

        const pick = model.picks[index];
        if (pick) {
          const age = previous ? time - previous.onsetSeconds : Number.POSITIVE_INFINITY;
          const attack = preparation
            ? smooth((time - (preparation.onsetSeconds - 0.08)) / 0.08)
            : 0;
          const rebound = age < 0.16 ? 1 - smooth(age / 0.16) : 0;
          const stroke = Math.max(attack, rebound);
          pick.rotation.z = picksRest.get(pick)! - 0.42 + 0.42 * stroke;
          pick.position.z = pickContactZ.get(pick)! + 0.008 * (1 - stroke);
        }
      }
    }

    // A model exposing applyMechanics owns the complete drum motion contract.
    // Do not overwrite its reduced-motion rests or measured contact poses with
    // the legacy generic path below.
    if (!hasModelDrumMechanics) {
      for (const id of ['left', 'right'] as const) {
        const stick = models.drums.sticks.get(id);
        if (!stick) continue;
        const tip = strokeTip(
          time,
          stickEvents.get(id) ?? [],
          models.drums.hitAnchors,
          new THREE.Vector3(id === 'left' ? -0.45 : 0.45, 1.3, 0),
          reducedMotion,
        );
        const direction = new THREE.Vector3(id === 'left' ? 0.18 : -0.18, -0.45, 0.86).normalize();
        stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
        stick.position.copy(tip).addScaledVector(direction, -0.4);
      }

      const kicks = neighboringEvents(byPart.get('drums.kick') ?? [], time);
      const kickAge = kicks.previous ? time - kicks.previous.onsetSeconds : Number.POSITIVE_INFINITY;
      const kickPreparation = kicks.next
        ? smooth((time - (kicks.next.onsetSeconds - 0.1)) / 0.1)
        : 0;
      const kickRebound = kickAge < 0.18 ? 1 - smooth(kickAge / 0.18) : 0;
      models.drums.kickBeater.rotation.x =
        kickAngles.restRotationX +
        (kickAngles.contactRotationX - kickAngles.restRotationX) *
          Math.max(kickPreparation, kickRebound);

      for (const [id, object] of models.drums.cymbals) {
        const key = id.startsWith('drums.') ? id : `drums.${id}`;
        const event = neighboringEvents(byPart.get(key) ?? [], time).previous;
        const age = event ? time - event.onsetSeconds : Number.POSITIVE_INFINITY;
        const sway = reducedMotion
          ? 0
          : age < 2 && event
            ? Math.sin(age * 35) * Math.exp(-age * 4) * 0.05 * event.velocity
            : 0;
        object.rotation.z = cymbalRest.get(id)! + sway;
      }
    }
  }

  function getTrackEnvelope(timeSeconds: number): TrackEnvelope {
    const time = Number.isFinite(timeSeconds)
      ? THREE.MathUtils.clamp(timeSeconds, 0, score.durationSeconds)
      : 0;
    return {
      piano: evaluateTrackEnvelope(byTrack.get('piano')!, time),
      guitar: evaluateTrackEnvelope(byTrack.get('guitar')!, time),
      bass: evaluateTrackEnvelope(byTrack.get('bass')!, time),
      drums: evaluateTrackEnvelope(byTrack.get('drums')!, time),
    };
  }

  function setAudibleTracks(trackIds: readonly TrackId[]): void {
    audibleTracks = new Set(trackIds.filter((id): id is TrackId => ids.includes(id)));
  }

  function getAudibleTracks(): readonly TrackId[] {
    return ids.filter((id) => audibleTracks.has(id));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    root.removeFromParent();
  }

  const rig: PerformanceRig = {
    root,
    instrumentGroups,
    components,
    models,
    apply,
    getTrackEnvelope,
    setAudibleTracks,
    getAudibleTracks,
    dispose,
  };
  // The model's first pose is the authored startup pose.  Reduced-motion is
  // a render-time preference and must not force a performance-open lid before
  // the first stage frame supplies that preference.
  apply(0, false);
  return rig;
}
