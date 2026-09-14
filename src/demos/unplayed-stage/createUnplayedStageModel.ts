import * as THREE from 'three';

import electricGravityScore from './data/rock-score.json';
import canonScore from './data/canon-score.json';
import electricGravityAudio from './audio/electric-gravity.mp3?url';
import canonAudio from './audio/canon.mp3?url';
import { createBassModel } from './instruments/models/createBassModel';
import { createDrumsModel } from './instruments/models/createDrumsModel';
import { createGuitarModel } from './instruments/models/createGuitarModel';
import { createPianoModel } from './instruments/models/createPianoModel';
import { createPerformanceRig } from './instruments/PerformanceRig';
import type { Score } from './music/ScoreLoader';

const TRACKS = ['piano', 'guitar', 'bass', 'drums'] as const;
type TrackId = (typeof TRACKS)[number];

const INSTRUMENT_POSITIONS: Record<TrackId, [number, number, number]> = {
  piano: [-2.6, 0, 0.4],
  bass: [-0.7, 0, 0.7],
  drums: [0, 0.3375, -1.5],
  guitar: [2.7, 0, 0.4],
};

function layoutInstrumentRig(rig: Rig): void {
  for (const id of TRACKS) {
    const group = rig.instrumentGroups[id];
    group.position.set(...INSTRUMENT_POSITIONS[id]);
    group.rotation.y = id === 'piano' ? -0.25 : 0;
    group.userData.stageAnchor = INSTRUMENT_POSITIONS[id];
  }
}

function stageBox(
  parent: THREE.Object3D,
  name: string,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildStage(): THREE.Group {
  const stage = new THREE.Group();
  stage.name = 'unplayed-stage.environment';
  stage.userData.assetSource = 'procedural';

  const floor = new THREE.MeshStandardMaterial({ color: 0x10131a, roughness: 0.28, metalness: 0.48 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x8b553b, roughness: 0.3, metalness: 0.72 });
  const curtain = new THREE.MeshStandardMaterial({ color: 0x130e19, roughness: 0.9, metalness: 0.02 });
  const warm = new THREE.MeshBasicMaterial({ color: 0xd86e45, toneMapped: false });
  const cool = new THREE.MeshBasicMaterial({ color: 0x6f8fd0, toneMapped: false });

  stageBox(stage, 'stage.floor', [12.8, 0.12, 7.2], [0, -0.06, 0], floor);
  stageBox(stage, 'stage.front-edge', [12.8, 0.06, 0.08], [0, 0.04, 3.55], trim);
  stageBox(stage, 'stage.back-wall', [12.8, 5.4, 0.18], [0, 2.6, -3.45], curtain);
  stageBox(stage, 'stage.left-wing', [0.22, 4.8, 7.0], [-6.25, 2.35, 0], curtain);
  stageBox(stage, 'stage.right-wing', [0.22, 4.8, 7.0], [6.25, 2.35, 0], curtain);
  stageBox(stage, 'stage.riser', [6.6, 0.18, 2.8], [0, 0.09, -1.85], trim);

  for (const x of [-4.8, -2.0, 0, 2.0, 4.8]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.08, 16), warm);
    lamp.name = 'stage.practical.warm';
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(x, 4.35, -3.2);
    stage.add(lamp);
  }
  for (const x of [-3.6, 3.6]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.08, 16), cool);
    lamp.name = 'stage.practical.cool';
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(x, 3.65, -3.18);
    stage.add(lamp);
  }

  stage.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return stage;
}

export function installUnplayedStageLights(scene: THREE.Scene): void {
  const ambient = new THREE.HemisphereLight(0x392e4b, 0x08070d, 0.46);
  ambient.name = 'stage.ambient';
  scene.add(ambient);

  const key = new THREE.SpotLight(0xffb56f, 28, 24, Math.PI / 5.2, 0.7, 1.25);
  key.name = 'stage.key';
  key.position.set(-4.5, 6.8, 4.8);
  key.target.position.set(-0.6, 0.8, 0.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key, key.target);

  const rim = new THREE.SpotLight(0x7f9bd4, 18, 22, Math.PI / 5, 0.78, 1.3);
  rim.name = 'stage.rim';
  rim.position.set(4.5, 5.8, -3.2);
  rim.target.position.set(1.0, 0.8, -0.8);
  rim.castShadow = true;
  rim.shadow.mapSize.set(1024, 1024);
  scene.add(rim, rim.target);

  const wash = new THREE.RectAreaLight(0xff8e67, 1.4, 8, 3);
  wash.name = 'stage.wash';
  wash.position.set(0, 3.0, -3.0);
  wash.lookAt(0, 0.9, 0);
  scene.add(wash);
}

interface AnimationController {
  readonly actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
  readonly active: string;
  play(name: string): void;
  stop(): void;
  subscribe(listener: (active: string) => void): () => void;
}

type Rig = ReturnType<typeof createPerformanceRig>;

function makeController(
  root: THREE.Group,
  rockRig: Rig,
  rockAudio: HTMLAudioElement,
  canonScoreValue: Score,
): AnimationController {
  const listeners = new Set<(active: string) => void>();
  let active = 'idle';
  let playing = false;
  let activeSong: 'rock' | 'canon' = 'rock';
  let time = 0;
  let canonRig: Rig | undefined;
  let canonAudioElement: HTMLAudioElement | undefined;
  const actions = [
    { id: 'electric-gravity', label: 'Electric Gravity · 132 s', loop: true },
    { id: 'canon', label: 'Canon · 104 s', loop: true },
  ] as const;

  const emit = (): void => listeners.forEach((listener) => listener(active));
  const stop = (): void => {
    playing = false;
    active = 'idle';
    rockAudio.pause();
    rockAudio.currentTime = 0;
    canonAudioElement?.pause();
    if (canonAudioElement) canonAudioElement.currentTime = 0;
    time = 0;
    (activeSong === 'canon' ? canonRig : rockRig)?.apply(0, false);
    activeSong = 'rock';
    rockRig.root.visible = true;
    if (canonRig) canonRig.root.visible = false;
    emit();
  };

  root.userData.tick = (dt: number): void => {
    if (!playing) return;
    const rig = activeSong === 'canon' ? canonRig : rockRig;
    const audio = activeSong === 'canon' ? canonAudioElement : rockAudio;
    const duration = activeSong === 'canon' ? canonScoreValue.durationSeconds : 132;
    time = Math.min(duration, time + Math.max(0, Math.min(dt, 0.1)));
    rig?.apply(time, false);
    if (audio && audio.readyState >= 2 && Math.abs(audio.currentTime - time) > 0.14) audio.currentTime = time;
    if (time >= duration || audio?.ended) stop();
  };

  return {
    actions,
    get active() { return active; },
    play(name) {
      if (name !== 'electric-gravity' && name !== 'canon') return;
      if (name === 'canon' && !canonRig) {
        const models = {
          piano: createPianoModel(),
          guitar: createGuitarModel(),
          bass: createBassModel(),
          drums: createDrumsModel(),
        };
        canonRig = createPerformanceRig(canonScoreValue, models);
        layoutInstrumentRig(canonRig);
        canonRig.root.visible = false;
        root.add(canonRig.root);
        canonAudioElement = new Audio(canonAudio);
        canonAudioElement.preload = 'metadata';
        canonAudioElement.volume = 0.7;
      }
      activeSong = name === 'canon' ? 'canon' : 'rock';
      rockRig.root.visible = activeSong === 'rock';
      if (canonRig) canonRig.root.visible = activeSong === 'canon';
      playing = true;
      active = name;
      time = 0;
      const audio = activeSong === 'canon' ? canonAudioElement : rockAudio;
      if (!audio) return;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
      emit();
    },
    stop,
    subscribe(listener) {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
}

export function createUnplayedStageModel(scene?: THREE.Scene): THREE.Group {
  const raw = electricGravityScore as unknown as {
    version: string;
    durationSeconds: number;
    bpm: number;
    meter: [number, number];
    notes: Score['notes'];
    controllers: Score['controllers'];
  };
  const score: Score = {
    version: raw.version,
    durationSeconds: raw.durationSeconds,
    bpm: raw.bpm,
    meter: raw.meter,
    notes: raw.notes,
    controllers: raw.controllers,
  };
  const canonRaw = canonScore as unknown as {
    version: string;
    durationSeconds: number;
    bpm: number;
    meter: [number, number];
    notes: Score['notes'];
    controllers: Score['controllers'];
  };
  const canonScoreValue: Score = {
    version: canonRaw.version,
    durationSeconds: canonRaw.durationSeconds,
    bpm: canonRaw.bpm,
    meter: canonRaw.meter,
    notes: canonRaw.notes,
    controllers: canonRaw.controllers,
  };
  const piano = createPianoModel();
  const guitar = createGuitarModel();
  const bass = createBassModel();
  const drums = createDrumsModel();
  const rig = createPerformanceRig(score, { piano, guitar, bass, drums });
  const root = new THREE.Group();
  root.name = 'unplayed-stage';
  root.userData.assetSource = 'procedural';
  root.userData.provenance = {
    route: 'image-to-procedural reconstruction',
    exactnessTier: 'authored procedural stage and instrument assembly',
    inferred: ['depth', 'hidden surfaces', 'stage lighting response'],
  };

  layoutInstrumentRig(rig);
  root.add(rig.root);

  const audio = new Audio(electricGravityAudio);
  audio.preload = 'metadata';
  audio.volume = 0.7;
  const controller = makeController(root, rig, audio, canonScoreValue);
  const exportModels = TRACKS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), root: rig.instrumentGroups[id] }));
  root.userData.sculptRuntime = {
    version: 1,
    rigType: 'procedural-performance-stage',
    animationController: controller,
    exportModels,
  };
  root.userData.exportModels = exportModels;
  const stage = scene ? buildStage() : undefined;
  root.userData.cleanup = (): void => {
    controller.stop();
    audio.removeAttribute('src');
    audio.load();
    stage?.removeFromParent();
  };

  if (stage && scene) scene.add(stage);
  rig.apply(0, false);
  return root;
}

export default createUnplayedStageModel;
