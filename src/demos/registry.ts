import * as THREE from 'three';
import type { PinnedCaptureCamera } from '../scene';
import {
  createStarshipSuperHeavyLookDevLights,
  createStarshipSuperHeavyModel,
} from './starship-super-heavy/createStarshipSuperHeavyModel';
import {
  createM9DopplerModel,
  createM9DopplerLookDevLights,
  makeM9DopplerBackground,
} from './m9-doppler/createM9DopplerModel';
import {
  createRazShowcase,
  createRazLights,
} from './raz/razShowcase';
import { prewarmRaz } from './raz/createRazModel';
import { createCrownChestModel } from './crown-chest/createCrownChestModel';
import {
  createWarHaulerModel,
  createWarHaulerLookDevLights,
} from './warhauler/createWarHaulerModel';
import {
  createDoraemonHouseModel,
  createDoraemonHouseLookDevLights,
  makeSkyTexture,
} from './doraemon-house/createDoraemonHouseModel';
import {
  createGerberKnifeModel,
  createGerberKnifeLookDevLights,
  makeStudioBackground,
} from './gerber-knife/createGerberKnifeModel';
import {
  createIssacaShotgunModel,
  createIssacaShotgunLookDevLights,
  makeIssacaBackground,
} from './issaca-shotgun/createIssacaShotgunModel';
import {
  createSonyWf1000xm3Model,
  createSonyWf1000xm3LookDevLights,
  makeSonyBackground,
} from './sony-wf1000xm3/createSonyWf1000xm3Model';
import {
  createBMXEnduranceBikeModel,
  createBMXEnduranceBikeLookDevLights,
} from './bmx-endurance/createBmxEnduranceBikeModel';
import {
  createClassicFadeModel,
  createClassicFadeLookDevLights,
  makeClassicFadeBackground,
} from './classic-fade/createClassicFadeModel';
import {
  createGlockGhostProtocolModel,
  createGlockGhostProtocolLookDevLights,
  makeGhostProtocolBackground,
} from './glock-ghost-protocol/createGlockGhostProtocolModel';
import {
  createAWPMedusaMinimalWearModel,
  createAWPMedusaMinimalWearLookDevLights,
  makeAWPMedusaMinimalWearBackground,
} from './awp-medusa-v2/createAwpMedusaModelV2';
import {
  createElectricMouseMascotLookDevLights,
  createElectricMouseMascotModel,
} from './electric-mouse-mascot/createElectricMouseMascotModel';
import {
  createGirlCharacterModel,
  createGirlCharacterLookDevLights,
  prewarmGirlCharacter,
} from './girl-character/createGirlCharacterModel';
import {
  createTalonDopplerRubyModel,
  createTalonDopplerRubyLookDevLights,
  makeTalonDopplerRubyBackground,
} from './talon-doppler-ruby/createTalonDopplerRubyModel';
import {
  createLowPolyHumanoidLookDevLights,
  createLowPolyHumanoidModel,
  prewarmLowPolyHumanoidField,
} from './low-poly-humanoid/createLowPolyHumanoidModel';
import {
  createWarriorLookDevLights,
  createWarriorModel,
  prewarmWarrior,
} from './warrior/createWarriorModel';
import { createBoxingManShowcase, createRingsideLights } from './boxing-man/boxingManShowcase';
import { prewarmBoxingMan } from './boxing-man/createBoxingManModel';
import {
  createRegretWarriorLookDevLights,
  createRegretWarriorModel,
} from './regret-warrior-reconstruction/createRegretWarriorModel';

import {
  createGirlCharacter3Model,
  createGirlCharacter3LookDevLights,
  prewarmGirlCharacter3,
} from './girl-character-3/createGirlCharacter3Model';
import {
  createLeesinModel,
  prewarmLeesin,
} from './leesin/leesinDemo';
import {
  createMarsCatLookDevLights,
  createMarsCatModel,
} from './mars-cat/createMarsCatModel';

export interface DemoEntry {
  /** route id, e.g. 'crown-chest' */
  id: string;
  title: string;
  subjectClass: 'object' | 'character';
  /** 1-2 sentences */
  blurb: string;
  referenceImage: string;
  /**
   * WHAT THE RECONSTRUCTION WAS MEASURED FROM, which is the single most important thing to know when
   * reading any number on this page. Default `image`.
   *
   * `image` — photographs or renders. Only two dimensions are given, so every depth, every cross-section
   * profile and every hidden face is INFERRED, and a silhouette match is the strongest claim available.
   * `model` — an existing 3D asset. Geometry is MEASURED: cross-sections, triangle counts and per-part
   * volumes are read off the reference, so a claim like "the reference's exact triangle count" means
   * something here and could not be stated at all from an image.
   *
   * The two deserve different credit and different scepticism, and a visitor cannot tell them apart from
   * a thumbnail -- a render of a GLB and a photograph look alike.
   */
  referenceKind?: 'image' | 'model';
  /** Where the reference itself can be inspected, when it is something a visitor can open. */
  referenceUrl?: string;
  /** repo-relative path shown in UI */
  sourcePath: string;
  sourceUrl: string;
  generatedWith: string;
  /**
   * The reconstruction prompt this demo was built from — the subject description handed to
   * img2threejs, kept next to the result so the two can be read against each other.
   */
  prompt?: string;
  /** display name of whoever contributed this demo */
  author: string;
  /** link to the author's profile (GitHub, etc.) */
  authorUrl: string;
  /**
   * Optional link to the Tripo asset this demo was generated from. The reconstruction is still
   * code, but where a Tripo generation was the measurement instrument, the asset is part of the
   * provenance and belongs next to the result.
   */
  tripoUrl?: string;
  /** Optional link to the ArtStation artwork the reference image comes from. */
  artstationUrl?: string;
  status: 'placeholder' | 'final';
  /**
   * When this exhibit was last worked on, `YYYY-MM-DD`, taken from the last commit that touched its
   * folder. The gallery is ordered by it, newest first.
   *
   * Recorded here rather than derived: the browser cannot read git history, and a build-time stamp would
   * make every exhibit look updated on every deploy.
   */
  updatedAt: string;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  cameraFov: number;
  /** Optional per-demo accent (hex) — themes the panel to the object's signature colour. */
  accent?: string;
  /** Optional radial-gradient backdrop (inner→outer hex) for a themed hero stage. */
  backgroundGradient?: { inner: string; outer: string };
  /** ACES exposure (default 1.0); <1 = darker/moodier to match a low-key reference. */
  exposure?: number;
  /** Scene IBL intensity (default 1.0); <1 = less ambient fill. */
  environmentIntensity?: number;
  /** Tone-mapping operator (default 'aces'); 'agx' preserves saturated crimson/red a Ruby-Doppler
   * blade needs (ACES desaturates pure red toward pink/brown). */
  toneMapping?: 'aces' | 'agx' | 'neutral';
  /**
   * Installs this demo's own light rig. When provided, the Viewer SKIPS its
   * default studio rig — preventing the double-lighting (own rig + default rig)
   * that blows out highlights and washes out low-key references. Demos with a
   * bespoke look-dev rig MUST use this instead of adding lights inside build().
   */
  installLights?: (scene: THREE.Scene) => void;
  /**
   * Orbit the camera slowly on load, so a subject whose sides differ shows them without a drag
   * (default false). The visitor can stop it from the toolbar, and a drag pauses it either way.
   */
  turntable?: boolean;
  /** Adds the model (and any demo-specific lights) to the scene, returns the group. */
  build: (scene: THREE.Scene) => THREE.Group;
  /**
   * Precomputes this demo's expensive intermediates, yielding to the browser as it goes.
   *
   * `build` is synchronous by contract and every caller may keep treating it that way. This is for
   * demos whose build is heavy enough to be felt as a frozen page — awaiting it first moves that
   * cost off the critical path, after which `build` is cheap. Resolving twice is a no-op, and the
   * result is cached for the lifetime of the module, so any later `build` is fast too.
   */
  prewarm?: () => Promise<void>;
  /** Action id to start automatically once the runtime lands. Skipped in capture mode. */
  defaultAnimation?: string;
  /** Optional deterministic capture framing margin for source plates with tight bounds. */
  captureMargin?: number;
  /** Optional vertical framing correction as a fraction of the measured subject bbox height. */
  captureTargetOffsetY?: number;
  /** Optional reverse-view vertical correction for asymmetric source padding. */
  captureTargetOffsetYBack?: number;
  /** Optional capture-only world-X correction for asymmetric transparent source padding. */
  captureTargetOffsetX?: number;
  /** Optional reverse-view capture correction; the back plate has different transparent padding. */
  captureTargetOffsetXBack?: number;
  /**
   * Explicit review camera per broadside. When present, capture uses these numbers instead of
   * frameForCapture()'s bbox-derived framing, so a geometry change cannot reframe the shot.
   */
  capturePinnedCamera?: { front: PinnedCaptureCamera; back: PinnedCaptureCamera };
}

import { createAbyssLights, createMonsterShowcase } from './monster/monsterShowcase';
import { prewarmMonster } from './monster/createMonsterModel';

const BASE = import.meta.env.BASE_URL;
const REPO = 'https://github.com/img2threejs/img2threejs-showcase/blob/main';

const authored: DemoEntry[] = [
  {
    id: 'raz',
    updatedAt: '2026-09-03',
    title: 'Raz — Detonating Strike VFX',
    subjectClass: 'character',
    blurb:
      'A code-only measured reconstruction (286,108 triangles in one embedded surface stream) on its '
      + 'own 41-bone rig with twenty-five embedded clips, wearing an effects layer whose every timing '
      + 'was measured rather than authored: the original twenty-four clips were swept at 400 samples to find '
      + 'where the crystal knuckles and boot soles actually reach their extension apex at speed. The '
      + 'four jade blocks the reference shows never stop burning — green fire and smoke pour off them '
      + 'continuously, thickening with the limb\u2019s own live velocity — and a landed punch or kick '
      + 'detonates that same fire all at once: a windup gather, shock rings pushed down the travel '
      + 'axis, crystal shrapnel under real gravity, a smoke bloom, a spiking emerald light, a floor '
      + 'ripple and 45-100 ms of hitstop. The Knockout uses a supplied uppercut retargeted into the '
      + 'same rig: its fist loads close to the hip, rises 61 degrees to 0.812 figure heights at '
      + '4.82 H/s, while the hip is still driving upward. The finish reads in four beats: a compact boxing guard, a 1.35x '
      + 'run-in that smears into four reduced-mesh echoes, a 0.12-unit knee-loading crouch, then a 1.15x uppercut. The '
      + 'fighter launches 0.42 units with the punch, then lets the measured follow-through unfold through one reverse '
      + '360-degree turn while descending for 0.965 seconds onto the same mark before the '
      + 'loop resets; three shock rings go out flat above his head '
      + 'instead of two down a travel axis, and about 159 ms of powered hitstop holds it before the crystals roar. '
      + 'Nothing is fetched: geometry, per-vertex colour and every keyframe are TypeScript.',
    referenceImage: `${BASE}references/raz/reference.jpg`,
    sourcePath: 'src/demos/raz/razVfx.ts',
    sourceUrl: `${REPO}/src/demos/raz/razVfx.ts`,
    generatedWith: 'img2threejs v1.5.2 \u00b7 playground \u00b7 Tripo measurement \u00b7 GLB fast lane \u00b7 measured-event VFX',
    author: 'Ho\u00e0i Nh\u1edb',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    /**
     * Authored on the side the figure actually punches towards, which is not where the playground's
     * own framing put it. Sweeping the shoulder line (signed by the ankle-to-toe vector) at every
     * measured contact puts the three punches of the default clip between yaw -30 and +30 degrees —
     * +X — so the download's +Z camera watched the combination from the side. This is a
     * three-quarter on that axis, at the download's own distance, so the crystals travel towards the
     * lens. The kicks turn the figure the other way and land at yaw 117-156; they read as thrown
     * away from camera, which is the cost of framing for the clip that plays by default.
     */
    cameraPosition: [4.78, 1.12, 2.68],
    cameraTarget: [0, 1.10, 0],
    cameraFov: 33,
    accent: '#3dff8c',
    backgroundGradient: { inner: '#0c1a14', outer: '#050807' },
    /**
     * Held just under neutral. The effects layer is additive and additive blending can only brighten
     * what is behind it, so a bright stage leaves a detonation nowhere to go — but the first pass at
     * 0.85 / 0.45 rendered the reference's brushed steel as a black silhouette with four green lamps
     * on it. This is the balance point: the plates read, and a burst still doubles them.
     */
    exposure: 1.0,
    environmentIntensity: 0.8,
    toneMapping: 'aces',
    // Both the level of detail and the 25-clip rig live in their own chunks, so they have to be
    // fetched before build() runs.
    prewarm: () => prewarmRaz().then(() => undefined),
    // Cold raked key, two jade rims that read as the crystals' own spill, and drifting jade haze.
    installLights: (scene) => scene.add(createRazLights()),
    build: (scene) => {
      const group = createRazShowcase({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'mars-cat',
    updatedAt: '2026-09-03',
    title: 'Mars Cat — Measured Procedural Surfaces',
    subjectClass: 'character',
    blurb:
      'A code-bundled Surface Nets reconstruction of all 17 measured GLB regions, now bound to the '
      + 'reference GLB\'s 95-joint skin order. The default medium stream retains the polished fidelity '
      + 'geometry; the separately frozen low/game tier has 406,452 triangles (90.39% fewer), conditioned '
      + 'skin weights, and a measured repair for the source pocket-to-thumb misweight. One idle and a '
      + '12-action Raz-compatible menu are authored because the reference contains no clips. No reference GLB, binary surface '
      + 'file, texture image or UV atlas is shipped or fetched.',
    referenceImage: `${BASE}references/mars-cat.webp`,
    referenceKind: 'model',
    sourcePath: 'src/demos/mars-cat/createMarsCatModel.ts',
    sourceUrl: `${REPO}/src/demos/mars-cat/createMarsCatModel.ts`,
    generatedWith: 'img2threejs v1.5.2 · measured Surface Nets and GLB-referenced rig',
    prompt:
      'Reconstruct every multipart GLB surface at its measured per-node cell size and bake declared '
      + 'material values into code. Use the source model only as a measurement instrument; do not '
      + 'ship its topology, textures, UV atlas or binary geometry. Preserve the GLB skin joint order, '
      + 'bind additively after a mesh freeze, and reject authored motion that breaks the surface.',
    author: 'Rigs',
    authorUrl: 'https://github.com/ClassicsCrypto',
    status: 'final',
    cameraPosition: [-1.4901161193847656e-7, 0.5757730114273727, 3.0168617736281305],
    cameraTarget: [-1.4901161193847656e-7, 0.5757730114273727, -0.08574904501438141],
    cameraFov: 25,
    turntable: true,
    accent: '#159de0',
    backgroundGradient: { inner: '#263343', outer: '#0a0c11' },
    exposure: 1,
    environmentIntensity: 0.85,
    toneMapping: 'agx',
    installLights: (scene) => scene.add(createMarsCatLookDevLights()),
    build: (scene) => {
      const group = createMarsCatModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'monster',
    updatedAt: '2026-08-27',
    title: 'Abyss Monster \u2014 Wind-Rending VFX',
    subjectClass: 'character',
    blurb:
      'A code-only measured reconstruction (115,745 triangles in one embedded surface stream) on its '
      + 'own 41-bone rig with twenty-seven embedded clips, wearing an abyss layer whose every timing '
      + 'was measured rather than authored: all twenty-seven clips were swept at 400 samples to find '
      + 'where the claws actually stop at extension, where weight actually meets the ground, and where '
      + 'the head is driven by a blow the figure takes. An attack tears the air along the arc the limb '
      + 'ACTUALLY swung through \u2014 the swing axis comes from the shoulder-to-claw radius crossed with '
      + 'the measured travel \u2014 and the contact FRACTURES the air like a pane of glass: a fresh '
      + 'spoke-and-ring lattice per impact whose cracks run outward over ~100 ms, white-hot at the '
      + 'travelling tip, throwing instanced glass that glints as it tumbles. A stomp cracks the floor '
      + 'the same way. Behind it all, a shear cone, void rings down the strike axis and 50-95 ms of '
      + 'hitstop. Around the body, 260 wisps orbit eleven bones on per-mote lag '
      + 'so the cloud strings out behind a lunge, non-additive ash sheds off the shoulders, and the '
      + 'floor swirls under it. Nothing is fetched: geometry, per-vertex colour and every keyframe are '
      + 'TypeScript.',
    referenceImage: `${BASE}references/monster/reference.png`,
    sourcePath: 'src/demos/monster/abyssVfx.ts',
    sourceUrl: `${REPO}/src/demos/monster/abyssVfx.ts`,
    generatedWith: 'img2threejs playground \u00b7 Tripo v3.1-20260211 measurement \u00b7 GLB fast lane \u00b7 measured-event VFX',
    prompt:
      'Gi\u00fap t\u00f4i t\u1ea1o 1 nh\u00e2n v\u1eadt high-poly c\u00f3 n\u1eafm \u0111\u1ea5m tay, nh\u00e2n v\u1eadt n\u00e0y l\u00e0 qu\u00e1i v\u1eadt c\u00f3 d\u00e1ng \u0111\u1ee9ng T pose, '
      + '\u0111\u00e2y l\u00e0 qu\u00e1i v\u1eadt m\u1ea1nh m\u1ebd c\u00f3 c\u01a1 b\u1eafp, \u0111\u00e2y l\u00e0 qu\u00e1i v\u1eadt trong game, v\u00e0 n\u00f3 c\u00f3 xung quanh l\u00e0 c\u00e1c l\u1edbp v\u1ea9y v\u00e0 x\u01b0\u01a1ng, '
      + '\u0111\u00f4i m\u1eaft \u0111\u00e1ng s\u1ee3 hung d\u1eef, c\u00f3 r\u0103ng nanh v\u00e0 \u0111\u00f4i c\u00e1nh, v\u00e0 kh\u1ed5ng l\u1ed3. background l\u00e0 transparent.',
    author: 'Ho\u00e0i Nh\u1edb',
    authorUrl: 'https://github.com/hoainho',
    tripoUrl: 'https://studio.tripo3d.ai/3d-model/7b81045c-10a9-4322-b329-0412d6f9f165?invite_code=PW9ZEA',
    status: 'placeholder',
    /**
     * Framed on the side the figure actually faces, which is not where the playground's own camera
     * put it. Sweeping the shoulder line (signed by the ankle-to-toe vector) across every clip in
     * the action list puts the facing at yaw 91-109 degrees \u2014 +X \u2014 so the download's +Z camera
     * watched the claws from behind. This is a three-quarter view on that axis, low enough that the
     * uplight and the floor swirl are both in frame.
     */
    cameraPosition: [4.72, 1.42, 2.24],
    cameraTarget: [0, 0.95, 0],
    cameraFov: 30,
    accent: '#9a54ff',
    backgroundGradient: { inner: '#171128', outer: '#05040a' },
    exposure: 0.92,
    environmentIntensity: 0.35,
    toneMapping: 'aces',
    // The level of detail lives in its own chunk, so it has to be fetched before build() runs.
    prewarm: () => prewarmMonster().then(() => undefined),
    // Uplight, cold moon, crimson rim: lighting for something that should not be lit.
    installLights: (scene) => scene.add(createAbyssLights()),
    build: (scene) => {
      const group = createMonsterShowcase({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'leesin',
    title: 'Lee Sin \u2014 Game Character',
    subjectClass: 'character',
    blurb:
      'A game character rebuilt as pure Three.js: BufferGeometry, SkinnedMesh, Skeleton and '
      + 'AnimationClip written in code, with no loader and nothing fetched while it runs. 69 meshes on '
      + 'a 42-bone rig, 10 measured animation clips, and strike effects in four elements \u2014 wind, '
      + 'fire, water and thunder \u2014 fired at the instant each hand finishes its travel. The '
      + 'reference model is a build-time measurement instrument and never reaches the viewer.',
    referenceImage: `${BASE}references/leesin/reference.jpg`,
    referenceKind: 'model',
    sourcePath: 'src/demos/leesin/createLeesinModel.ts',
    sourceUrl: `${REPO}/src/demos/leesin/createLeesinModel.ts`,
    generatedWith: 'img2threejs v1.5.1 \u00b7 pure Three.js, no loader, no runtime fetch',
    prompt:
      'Build the character in pure Three.js with no loader and no runtime fetch, using the reference '
      + 'only as a build-time measurement, and prove the result against its accessors.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    tripoUrl: 'https://studio.tripo3d.ai/3d-model/13f4f289-575c-403b-8dc0-fb6ee42b6e61?invite_code=PW9ZEA',
    status: 'final',
    updatedAt: '2026-08-28',
    cameraPosition: [0, 0.624311570879072, 4.597228490604114],
    cameraTarget: [0, 0.624311570879072, 0.007000002097338448],
    cameraFov: 25,
    accent: '#c5a56e',
    backgroundGradient: { inner: '#24221f', outer: '#0d0e10' },
    exposure: 0.9,
    environmentIntensity: 0.45,
    toneMapping: 'aces',
    prewarm: prewarmLeesin,
    defaultAnimation: 'step-and-swing-arms',
    build: (scene) => {
      const group = createLeesinModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'boxing-man',
    updatedAt: '2026-08-27',
    title: 'Ringside Boxer — Measured-Impact VFX',
    subjectClass: 'character',
    blurb:
      'A code-only measured reconstruction (97,592 triangles in one embedded surface stream) on its own '
      + '41-bone rig with nineteen embedded clips, wearing an effects layer whose every timing was '
      + 'measured rather than authored: all nineteen clips were swept at 400 samples to find where the '
      + 'gloves actually stop at extension, where weight actually meets the canvas, and where the head is '
      + 'driven by a blow the figure takes. A punch carries a windup charge, an air tear along the travel, '
      + 'shock rings that expand down the punch axis, sweat spray under real gravity, rosin dust off the '
      + 'canvas, a spiking impact light and 45-85 ms of hitstop. Nothing is fetched: geometry, per-vertex '
      + 'colour and every keyframe are TypeScript.',
    referenceImage: `${BASE}references/boxing-man/reference.jpg`,
    sourcePath: 'src/demos/boxing-man/boxingVfx.ts',
    sourceUrl: `${REPO}/src/demos/boxing-man/boxingVfx.ts`,
    generatedWith: 'img2threejs playground · Tripo v3.1-20260211 measurement · GLB fast lane · measured-event VFX',
    prompt: 'Full body Boxing character with T pose',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    /**
     * Authored on the side the figure actually faces, which is not where the playground's own
     * framing put it. Sweeping the shoulder line (signed by the ankle-to-toe vector) across every
     * clip in the demo puts the facing at yaw 62-105 degrees — +X — so the download's +Z camera
     * watched the punches from behind. This is a three-quarter view on that axis: the guard reads,
     * and the cross travels towards the lens rather than away from it.
     */
    cameraPosition: [4.35, 1.14, 2.05],
    cameraTarget: [0, 0.95, 0],
    cameraFov: 30,
    accent: '#ff8a34',
    backgroundGradient: { inner: '#1d1a18', outer: '#08080a' },
    exposure: 0.95,
    environmentIntensity: 0.55,
    toneMapping: 'aces',
    // The level of detail lives in its own chunk, so it has to be fetched before build() runs.
    prewarm: () => prewarmBoxingMan().then(() => undefined),
    // Broadcast ring light: one hard warm key on a truss, a dimmer bank across the ring, two cool
    // rims to hold the silhouette against black, and rosin haze for the key to catch.
    installLights: (scene) => scene.add(createRingsideLights()),
    build: (scene) => {
      const group = createBoxingManShowcase({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'regret-warrior-reconstruction',
    updatedAt: '2026-08-25',
    title: 'Regret Warrior — Source-Preserving Code Reconstruction',
    subjectClass: 'character',
    blurb:
      'A deterministic TypeScript reconstruction of the inventoried glTF 2.0 payload: 92 code-native '
      + 'BufferGeometry primitives, 184 embedded code-owned textures, the preserved 42-joint source rig '
      + 'and two authored secondary cloth joints. '
      + 'The original character GLB contains no animation clips or morph targets; the separate animation '
      + 'GLB contains three archived transform-only clips. Runtime actions include Review Turn and a new '
      + 'one-shot Revive animation that raises the character back to its measured bind pose while keeping '
      + 'the sword intact. A deterministic energy reveal, revive aura and moving specular light add '
      + 'presentation polish without changing the source textures or materials.',
    referenceImage: `${BASE}references/regret-warrior-reconstruction/1.jpg`,
    sourcePath: 'src/demos/regret-warrior-reconstruction/createRegretWarriorModel.ts',
    sourceUrl: `${REPO}/src/demos/regret-warrior-reconstruction/createRegretWarriorModel.ts`,
    generatedWith: 'img2threejs v1.5.1 · generated Three.js BufferGeometry and Skeleton',
    prompt:
      'Reconstruct the supplied Regret Warrior GLB as a deterministic, animation-ready, code-only '
      + 'Three.js group while preserving every discovered source field and making no GLB/GLTF/BIN request.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    cameraPosition: [0, 0.85, 4.4],
    cameraTarget: [0, 0.85, 0],
    cameraFov: 25,
    accent: '#d89a3d',
    backgroundGradient: { inner: '#222631', outer: '#0f1117' },
    exposure: 1,
    environmentIntensity: 0.8,
    toneMapping: 'aces',
    installLights: (scene) => scene.add(createRegretWarriorLookDevLights()),
    build: (scene) => {
      const group = createRegretWarriorModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'warrior',
    updatedAt: '2026-08-25',
    title: 'Mouse Warrior — Rigged Surface Character',
    subjectClass: 'character',
    blurb:
      'A code-only measured reconstruction with 47 embedded Surface Nets regions bound to a human-structured '
      + 'CharacterIR rig. The retained Tripo Motion 4 clip is embedded as code-native keyframes while '
      + 'procedural-only regions add measured secondary movement. '
      + 'Wood Staff Attack is driven by the clavicle-to-hand chain. '
      + 'Visual deformation fidelity remains conditional until browser multi-angle review is available.',
    referenceImage: `${BASE}references/warrior/mouse-warrior-reference.png`,
    sourcePath: 'src/demos/warrior/createWarriorModel.ts',
    sourceUrl: `${REPO}/src/demos/warrior/createWarriorModel.ts`,
    generatedWith: 'img2threejs v1.5.1 · CharacterIR retarget · procedural Surface Nets',
    prompt:
      'Build a procedural Three.js mouse warrior from the supplied GLB measurement instrument, '
      + 'retarget every measured animation channel above the GLB export-noise floor into code, '
      + 'then retain the hand-driven wooden-staff attack and secondary motion.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    tripoUrl: 'https://studio.tripo3d.ai/3d-model/b156287a-5a0c-434a-bc2e-9a7b8e108b5d?invite_code=PW9ZEA',
    artstationUrl: 'https://www.artstation.com/artwork/WB5nJX',
    status: 'placeholder',
    cameraPosition: [0, 0.4826, 5.8338],
    cameraTarget: [0, 0.4826, 0],
    cameraFov: 25,
    accent: '#9d714f',
    backgroundGradient: { inner: '#24201c', outer: '#0e0d0c' },
    exposure: 0.9,
    environmentIntensity: 0.7,
    toneMapping: 'aces',
    prewarm: prewarmWarrior,
    installLights: (scene) => scene.add(createWarriorLookDevLights()),
    build: (scene) => {
      const group = createWarriorModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'starship-super-heavy',
    updatedAt: '2026-09-03',
    title: 'Starship + Super Heavy',
    subjectClass: 'object',
    blurb:
      'The complete Starship and Super Heavy stack rebuilt entirely from procedural geometry: ' +
      'brushed stainless shells, a windward field of individually conformed hexagonal heat-shield ' +
      'tiles, hinged flaps, lattice grid fins, tank-dome structure, and explicit seven- and ' +
      'thirty-three-engine arrays. Live animation follows a safe three-stage separation route, ' +
      'presents both vehicles side by side, then returns the upper stage to the stack.',
    referenceImage: `${BASE}references/starship-super-heavy.webp`,
    sourcePath: 'src/demos/starship-super-heavy/createStarshipSuperHeavyModel.ts',
    sourceUrl: `${REPO}/src/demos/starship-super-heavy/createStarshipSuperHeavyModel.ts`,
    generatedWith: 'img2threejs v1.2.0',
    author: 'Jinliang Guo',
    authorUrl: 'https://github.com/too-young-too-naive',
    status: 'final',
    cameraPosition: [5.6, 4.2, 14.8],
    cameraTarget: [0.5, 3.8, 0],
    cameraFov: 34,
    accent: '#8da7c7',
    backgroundGradient: { inner: '#10203a', outer: '#050a13' },
    exposure: 1.15,
    environmentIntensity: 0.55,
    installLights: (scene) => {
      scene.add(createStarshipSuperHeavyLookDevLights());
    },
    build: (scene) => {
      const group = createStarshipSuperHeavyModel();
      scene.add(group);
      return group;
    },
  },
  {
    id: 'girl-character',
    updatedAt: '2026-08-18',
    title: 'Dual-Sword Warrior — TypeScript procedural surfaces',
    subjectClass: 'character',
    blurb:
      'A code-only Three.js character assembled from encoded Surface Nets data embedded in TypeScript. '
      + 'High, Medium and Low quality streams are lazy-loaded as separate TypeScript modules, keeping '
      + 'the athletic dual-sword warrior detailed and responsive across devices. Animation controls and '
      + 'the parts inspector remain available in the live demo.',
    referenceImage: `${BASE}references/girl-character/front.jpg`,
    prewarm: prewarmGirlCharacter,
    sourcePath: 'src/demos/girl-character/createGirlCharacterModel.ts',
    sourceUrl: `${REPO}/src/demos/girl-character/createGirlCharacterModel.ts`,
    generatedWith: 'img2threejs v1.5.1 · procedural TypeScript Surface Nets',
    prompt:
      'Reconstruct the athletic dual-sword warrior as an independent code-only Three.js character, '
      + 'preserve the athletic silhouette, dual swords, layered outfit and expressive face, while '
      + 'exposing High/Medium/Low quality levels for a responsive interactive render.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    cameraPosition: [0, 0.9, 4.45],
    cameraTarget: [0, 0.9, 0],
    cameraFov: 25,
    accent: '#b8402c',
    backgroundGradient: { inner: '#1a1a1a', outer: '#0f0f0f' },
    exposure: 0.55,
    environmentIntensity: 1.0,
    toneMapping: 'aces',
    installLights: (scene) => {
      scene.add(createGirlCharacterLookDevLights());
    },
    build: (scene) => {
      const group = createGirlCharacterModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'low-poly-humanoid',
    updatedAt: '2026-08-14',
    title: 'Low-Poly Humanoid — Rigged Character',
    subjectClass: 'character',
    blurb:
      'A code-only procedural humanoid sculpted with broad low-poly cuts across the chest, back, '
      + 'abdomen, arms, hands, legs, feet, fingers and toes. Its articulated runtime includes '
      + 'shoulder, elbow, wrist, finger, hip, knee, ankle, toe, eye and hair motion, deformable '
      + 'shorts, continuous torso-to-shoulder joins, and nine panel-controlled actions: Run, Jump, '
      + 'Kick, T-Pose Breathing, Fan Salute, Wave Left, Wave Right, Roundhouse and Dodge.',
    referenceImage: `${BASE}references/low-poly-humanoid-glb/humanoid.jpeg`,
    sourcePath: 'src/demos/low-poly-humanoid/createLowPolyHumanoidModel.ts',
    sourceUrl: `${REPO}/src/demos/low-poly-humanoid/createLowPolyHumanoidModel.ts`,
    generatedWith: 'img2threejs v1.5.0 · procedural character rig',
    prompt:
      'Reconstruct the supplied low-poly male humanoid as an independent code-only Three.js character. '
      + 'Preserve the angular anatomy, orange shorts, dark swept hair, articulated hands and feet, '
      + 'continuous shoulder seams, and flexible animation-ready body rig without copying source topology.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    cameraPosition: [0, 3.25, 9.4],
    cameraTarget: [0, 3.25, 0],
    cameraFov: 31,
    accent: '#f2690c',
    backgroundGradient: { inner: '#303030', outer: '#1d1d1d' },
    exposure: 0.95,
    environmentIntensity: 0.7,
    toneMapping: 'aces',
    installLights: (scene) => {
      scene.add(createLowPolyHumanoidLookDevLights('reference'));
    },
    // The only demo heavy enough to need this: its body is a 2.12M-sample signed-distance field.
    prewarm: prewarmLowPolyHumanoidField,
    build: (scene) => {
      const group = createLowPolyHumanoidModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'awp-medusa-v2',
    updatedAt: '2026-08-09',
    title: 'AWP | Medusa (Minimal Wear) · V2 rebuild',
    subjectClass: 'object',
    blurb:
      'Procedural CS2 AWP rebuilt from the admitted front/back broadside references. The silhouette gate is met at IoU 0.9205 front / 0.9171 back against a 0.90 target, and the Medusa artwork is projected from the reference\'s own de-lit pixels through the capture camera the plates are registered to. Macro shell profiles, open thumbhole, receiver, constant-diameter barrel with a squared front-sight block and a crowned muzzle, scope with a corrected objective flare and U-clamp ring saddles, receiver-parented bolt, trigger group, magazine, hinge, independent springs, telescoping bipod legs, feet, fasteners, sockets and idle tick are separate physical components with 15 verified contact pairs. Interactive: fire for muzzle flash, tracer, ejecting casing, recoil and bolt cycle; deploy the splayed bipod; look through the scope to line up the electric-mouse mascot, then fire to trigger its lightning burst and hit the reticle.',
    referenceImage: `${BASE}front-medusa.webp`,
    sourcePath: 'src/demos/awp-medusa-v2/createAwpMedusaModelV2.ts',
    sourceUrl: `${REPO}/src/demos/awp-medusa-v2/createAwpMedusaModelV2.ts`,
    generatedWith: 'img2threejs v1.4.4 · custom AWP rifle adapter · blockout + projection + interactions complete',
    author: 'kokorolx',
    authorUrl: 'https://github.com/kokorolx',
    status: 'final',
    cameraPosition: [0, 1.2, 11.5],
    cameraTarget: [0, 0.05, 0],
    cameraFov: 25,
    captureMargin: 1.0,
    // Source masks place the object bbox about 7/224 grid rows lower than
    // the previous auto-framed capture on both admitted broadside views.
    // This is a camera solve correction, not a geometry translation.
    captureTargetOffsetY: 0.08,
    captureTargetOffsetYBack: 0.08,
    // Pass-163 finding: frameForCapture() derives the camera from the scene bounding box, so every
    // geometry change reframed the review shot — lifting the optic 0.066 moved scaleDelta 0.0224 ->
    // 0.0044 and dropped both broadside IoUs ~0.039, an order of magnitude above the per-pass
    // geometry signal being measured. These are the exact numbers that framing produced at the
    // retained pass-157 geometry, frozen so later passes are measured instead of reframed. The
    // captureMargin/offset fields above are inert while this is set; they record how it was solved.
    capturePinnedCamera: {
      front: {
        position: [0.06105950944125864, 0.6510459728837025, 17.578492692244154],
        target: [0.06105950944125649, 0.6510459728837014, 0.01349999964237214],
        fov: 20,
        near: 16.511992697250943,
        far: 21.776992674005132,
      },
      back: {
        position: [0.06105950944125864, 0.6510459728837025, -17.551492692959407],
        target: [0.06105950944125649, 0.6510459728837014, 0.01349999964237214],
        fov: 20,
        near: 16.511992697250943,
        far: 21.776992674005132,
      },
    },
    accent: '#16669b',
    backgroundGradient: { inner: '#263b47', outer: '#081018' },
    exposure: 0.9,
    environmentIntensity: 0.82,
    toneMapping: 'neutral',
    installLights: (scene) => {
      scene.add(createAWPMedusaMinimalWearLookDevLights());
    },
    build: (scene) => {
      scene.background = makeAWPMedusaMinimalWearBackground();
      const group = createAWPMedusaMinimalWearModel({ shadows: true, qualityPriority: 'reference-fidelity' });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'electric-mouse-mascot',
    updatedAt: '2026-08-09',
    title: 'Pikachu 10K Star Celebration',
    subjectClass: 'character',
    blurb:
      'A code-only procedural reconstruction of the supplied stylized yellow mascot reference, ' +
      'staged as a 10k-star celebration: rounded capsule body, dark-tipped ears, open smiling ' +
      'mouth, red cheeks, angular tail, and a speech bubble whose counter rolls up to 10K under ' +
      'a lightning burst. Named semantic parts and lightweight animation controls throughout.',
    referenceImage: `${BASE}references/electric-mouse-mascot/reference.png`,
    sourcePath: 'src/demos/electric-mouse-mascot/createElectricMouseMascotModel.ts',
    sourceUrl: `${REPO}/src/demos/electric-mouse-mascot/createElectricMouseMascotModel.ts`,
    generatedWith: 'img2threejs v1.5-beta · procedural character track',
    prompt:
      'Rebuild the stylized yellow electric-mouse mascot in the reference image as a code-only '
      + 'procedural Three.js character, then stage it celebrating 10,000 GitHub stars.\n\n'
      + 'SUBJECT. One rounded capsule that reads as body and head at once (Body_Head_Main), with a '
      + 'single soft belly crease rather than a waist seam. Two tall tapered ears with dark tips '
      + '(Ear_L/Ear_R). Two round eyes with offset specular highlights (Eye_L/Eye_R, '
      + 'EyeHighlight_L/EyeHighlight_R), a small dark nose, and an open smiling mouth built as an '
      + 'outer lip, a dark inner cavity and a tongue (Mouth_Outer, Mouth_Inner, Tongue). Two red '
      + 'circular cheek patches (Cheek_L/Cheek_R) sitting flush on the body curvature, not floating '
      + 'above it. Short teardrop arms and feet (Arm_L/Arm_R, Foot_L/Foot_R). An angular '
      + 'lightning-bolt tail with brown flank accents at its base, hung off its own pivot so it can '
      + 'be animated independently (Tail_Pivot, Tail_Main, Tail_Accent, Tail_Accent_Flank_Upper/Lower).\n\n'
      + 'CELEBRATION STAGING. A speech bubble beside the head (SpeechBubble_Optional, '
      + 'SpeechBubble_Disc, SpeechBubble_Pointer) carrying a celebration star and a star-count label '
      + 'that rolls 9.80K → 9.86K → 9.91K → 9.95K → 9.98K → 9.99K → 9,999 → 10K and then holds on '
      + '10K (Star_10K_Label). On the hold, fire a lightning burst of bolts with an additive glow '
      + 'around the star (Star_Lightning_Burst) plus a lightning aura on the character '
      + '(Celebration_Lightning_Aura), keeping the silhouette readable — the burst must not wash the '
      + 'mascot out.\n\n'
      + 'CONSTRAINTS. No imported meshes: every surface is generated in TypeScript. Every part is '
      + 'named and semantically addressable so the runtime can drive it. Materials are physical, lit '
      + 'by one bespoke look-dev rig (createElectricMouseMascotLookDevLights) rather than a generic '
      + 'studio rig. The belly crease and its contact shadow stay parametric — the values ship as '
      + 'DEFAULT_ELECTRIC_MOUSE_BELLY_TUNE and are editable live through the shared tune panel.',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    cameraPosition: [2.60, 2.15, 9.20],
    cameraTarget: [0, 1.35, 0],
    cameraFov: 30,
    accent: '#ffd51a',
    backgroundGradient: { inner: '#ff8499', outer: '#ee5c7b' },
    exposure: 0.95,
    environmentIntensity: 0.48,
    toneMapping: 'aces',
    installLights: (scene) => {
      scene.add(createElectricMouseMascotLookDevLights());
    },
    build: (scene) => {
      const group = createElectricMouseMascotModel({ includeSpeechBubble: true });
      const runtime = group.userData.electricMouseMascotRuntime as ReturnType<typeof createElectricMouseMascotModel>['userData']['electricMouseMascotRuntime'];
      // The runtime exposes getBellyTune/setBellyTune so the belly crease can be driven live.
      // The editing UI for it is not part of this demo yet — it ships in v1.5.
      group.userData.tick = (_dt: number, elapsed: number) => runtime.update(elapsed);
      scene.add(group);
      return group;
    },
  },
  {
    id: 'glock-ghost-protocol',
    updatedAt: '2026-07-26',
    title: 'Glock-18 | Ghost Protocol (Well-Worn)',
    subjectClass: 'object',
    blurb:
      'A CS2 Glock-18 rebuilt in code from a FRONT/BACK reference pair, using a dedicated ' +
      'Glock-18 adapter rather than a generic pistol body. The silhouette is the alpha trace ' +
      'of the references — the two traces agree to 1.6 px — so the slide profile with its ' +
      'rear-sight block and front-sight blade, the slide/frame parting line, the dust cover ' +
      'and its four accessory-rail slots, the trigger-guard loop, the beavertail, the 22° grip ' +
      'rake and the ribbed magazine extension are all measured, not drawn. The Ghost Protocol ' +
      'finish is not a procedural circuit pattern: each broad face carries the de-lit reference ' +
      'crop for that side through one shared planar UV frame, so the magenta and orange trace ' +
      'bundles, "G18", "GLOCK(18)", "GHOST", "(*)", "PROTOCOL", the ">_" prompt and the ' +
      'bar-graph glyphs land exactly where the references put them. Roughness, metalness, AO ' +
      'and normal are separate authored channels built from the traced geometry, none derived ' +
      'from the albedo. No part is a constant-thickness extrusion: each shell is a loft whose ' +
      'cross-section varies with position, so the dust cover is slimmer than the receiver, the ' +
      'trigger-guard bow is a slender loop, the slide deck breaks in above the flats and the ' +
      'grip carries a palm swell under its raised panel. Because the shell is translucent ' +
      'polymer the internals are real mechanism, not paint: a lathed barrel with chamber swell, ' +
      'locking hood and bored muzzle, a coiled recoil spring on its guide rod, the striker, the ' +
      'breech face behind a genuinely cut ejection port, the magazine with feed lips and ' +
      'follower, and a Safe Action trigger group — a slotted curved shoe with a separate safety ' +
      'lever set into the slot, on its own matte grey polymer, riding a bar and connector that ' +
      'lift out of the frame as one module. Serrations and grip stria ' +
      'are ribs with real relief, not normal-map paint. Z thickness, every cross-section ' +
      'profile and the internals’ depth are inferred — both supplied views are broadside. ' +
      'Live: a slow studio rock. Hit “Explode parts” to take it apart.',
    referenceImage: `${BASE}references/glock-ghost-protocol.png`,
    sourcePath: 'src/demos/glock-ghost-protocol/createGlockGhostProtocolModel.ts',
    sourceUrl: `${REPO}/src/demos/glock-ghost-protocol/createGlockGhostProtocolModel.ts`,
    generatedWith: 'v1.4.1',
    author: 'kokorolx',
    authorUrl: 'https://github.com/kokorolx',
    status: 'final',
    // +Z side: a camera here reproduces the FRONT reference framing (muzzle to the right).
    cameraPosition: [0.2, 0.5, 4.85],
    cameraTarget: [0, -0.02, 0],
    cameraFov: 30,
    accent: '#c02234',
    backgroundGradient: { inner: '#2a1017', outer: '#070507' },
    // Operator SOLVED against the reference, not assumed. Khronos-neutral subtracts the
    // minimum channel (up to 0.04 linear) from all three, which on this deep-crimson polymer
    // wiped out ~60% of the green and pushed both faces off-hue; no tone mapping at all
    // washed green the other way (+28). ACES at these light levels lands the global mean on
    // the FRONT reference within 0.6/4.7/4.9 of RGB.
    toneMapping: 'aces',
    exposure: 1.0,
    environmentIntensity: 0.52,
    installLights: (scene) => {
      scene.add(createGlockGhostProtocolLookDevLights());
    },
    build: (scene) => {
      scene.background = makeGhostProtocolBackground();
      const group = createGlockGhostProtocolModel({ shadows: true });
      scene.add(group);

      // slow studio rock so the clearcoat travels along the slide and the translucent
      // frame reveals the barrel and the ribbon module from changing angles
      let t = 0;
      group.userData.tick = (dt: number) => {
        t += dt;
        // Kept to +-11 deg: the light rig and the material scalars were solved against the
        // broadside references, and past ~15 deg the environment starts to dominate the
        // clearcoat and the crimson drifts blue.
        group.rotation.y = Math.sin(t * 0.33) * 0.2;
        group.rotation.x = Math.sin(t * 0.21) * 0.035;
      };
      return group;
    },
  },
  {
    id: 'classic-fade',
    updatedAt: '2026-07-25',
    title: 'Classic Knife | Fade (Minimal Wear)',
    subjectClass: 'object',
    blurb:
      'A CS2 Classic Knife rebuilt in code from a FRONT/BACK reference pair, using a dedicated ' +
      'Classic Knife adapter. The silhouette is the alpha trace of the references, so the six ' +
      'rounded spine scallops, the deep semicircular choil, the hammer-head crossguard with its ' +
      'forward-canted quillon and lower spur, the five-step staircase butt plate with its ' +
      'countersunk lanyard bore and the drop-point tip are all measured, not drawn. The Fade ' +
      'finish is not a procedural gradient: each broad face carries the de-lit reference crop for ' +
      'that side, projected through one shared planar UV map, so the violet tip, the magenta and ' +
      'amber bands, the wavy lower-zone boundary, the grind tonal break, the gold beaded ferrule, ' +
      'the diamond-quilted grip and all four bolster screws land exactly where the references put ' +
      'them. Roughness, metalness, AO and normal are separate authored channels. Every part is a ' +
      'watertight solid rather than a plate with a picture on it: a through-tang runs the handle ' +
      'and the furniture is tenoned onto it, cross-sections roll over a finite-radius edge, and ' +
      'the four countersunk screws, the perforated lanyard bore, the beaded ferrule and the ' +
      'quilt relief are real geometry at the measured coordinates. Blade thickness, interior ' +
      'joinery and bead layout are inferred — both supplied views are broadside. Live: a slow ' +
      'studio rock.',
    referenceImage: `${BASE}references/classic-fade.png`,
    sourcePath: 'src/demos/classic-fade/createClassicFadeModel.ts',
    sourceUrl: `${REPO}/src/demos/classic-fade/createClassicFadeModel.ts`,
    generatedWith: 'img2threejs v1.3',
    author: 'kokorolx',
    authorUrl: 'https://github.com/kokorolx',
    status: 'final',
    // +Z side: a camera here reproduces the FRONT reference framing (blade to the right).
    cameraPosition: [0, 0.78, 5.3],
    cameraTarget: [0, -0.02, 0],
    cameraFov: 30,
    accent: '#c4426b',
    // Calibrated against the FRONT reference at the fixed review view: with the neutral
    // operator every material zone lands within ±10/255 of the reference. ACES matched the
    // blade but lifted the dark handle ~+16; neutral keeps both honest.
    toneMapping: 'neutral',
    exposure: 1.0,
    environmentIntensity: 1.0,
    installLights: (scene) => {
      scene.add(createClassicFadeLookDevLights());
    },
    build: (scene) => {
      scene.background = makeClassicFadeBackground();
      const group = createClassicFadeModel({ shadows: true });
      scene.add(group);

      // slow studio rock so the wedge grind and the anodized sheen travel across the blade
      let t = 0;
      group.userData.tick = (dt: number) => {
        t += dt;
        group.rotation.y = Math.sin(t * 0.35) * 0.32;
        group.rotation.x = Math.sin(t * 0.23) * 0.06;
      };
      return group;
    },
  },
  {
    id: 'bmx-endurance',
    updatedAt: '2026-07-23',
    title: 'BMX Endurance Bike',
    subjectClass: 'object',
    blurb:
      'An orange BMX "Endurance" bike rebuilt in code from a 12-view reference set: glossy ' +
      'clear-coat orange frame with fish-scale TIG weld beads, 5-spoke solid aero MAG wheels ' +
      '(gloss black + orange rim lip), block-tread tyres with "TERRAIN MONSTER / SHARP / 2022" ' +
      'sidewall lettering, ribbed orange grips, elongated PU-leather saddle, platform pedals with ' +
      'amber reflectors, 8-arm sunburst sprocket + roller chain, rear U-brake with straddle cable, ' +
      'a single slim front peg + knurled rear pegs, and BMX / Endurance decals. Live synchronized drivetrain: ' +
      'cranks turn, both wheels roll at the correct gear ratio.',
    referenceImage: `${BASE}references/bmx-endurance.jpg`,
    sourcePath: 'src/demos/bmx-endurance/createBmxEnduranceBikeModel.ts',
    sourceUrl: `${REPO}/src/demos/bmx-endurance/createBmxEnduranceBikeModel.ts`,
    generatedWith: 'img2threejs v1.3',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    // low ~45° isometric angle so the front end + fork read aggressive
    cameraPosition: [2.75, 0.5, 2.75],
    cameraTarget: [0, -0.12, 0],
    cameraFov: 33,
    exposure: 0.95,
    environmentIntensity: 0.62,
    // Single rig routed through installLights so the Viewer skips its default studio
    // rig — otherwise the two stack and wash the orange clear-coat out to pale yellow.
    installLights: (scene) => {
      scene.add(createBMXEnduranceBikeLookDevLights());
    },
    build: (scene) => {
      scene.background = new THREE.Color(0x0a0a0a); // dark studio stage (spec §4.A)
      const group = createBMXEnduranceBikeModel({ castShadow: true, receiveShadow: true });
      scene.add(group);

      // Contact-shadow floor right under the tyre contact patch (wheels sit at y≈-0.65),
      // so the bike grips the ground instead of floating (spec §4.C).
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(6, 6),
        new THREE.ShadowMaterial({ opacity: 0.55 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.655;
      floor.receiveShadow = true;
      scene.add(floor);

      // --- synchronized drivetrain rig (host-side, uses the model's node runtime) ---
      const nodes =
        (group.userData.sculptRuntime as { nodes?: Record<string, THREE.Object3D> } | undefined)
          ?.nodes ?? {};
      // Reparent parts onto a pivot at (cx,cy,0) so they spin about that axle.
      const pivotAt = (ids: string[], cx: number, cy: number): THREE.Group => {
        const pivot = new THREE.Group();
        pivot.position.set(cx, cy, 0);
        group.add(pivot);
        for (const id of ids) {
          const n = nodes[id];
          if (!n) continue;
          n.position.set(n.position.x - cx, n.position.y - cy, n.position.z);
          pivot.add(n); // children (e.g. spokes under a rim) travel with it
        }
        return pivot;
      };
      const frontWheel = pivotAt(['frontTire', 'frontRim', 'frontHub'], -0.66, -0.28);
      const rearWheel = pivotAt(['rearTire', 'rearRim', 'rearHub'], 0.52, -0.28);
      const crank = pivotAt(['crankArmL', 'crankArmR', 'chainring'], -0.02, -0.24);
      const pedals = ['pedalL', 'pedalR']
        .map((id) => nodes[id])
        .filter((n): n is THREE.Object3D => !!n);
      for (const p of pedals) {
        p.position.set(p.position.x - -0.02, p.position.y - -0.24, p.position.z);
        crank.add(p);
      }

      // chainring radius / rear-cog radius → rear wheel turns faster than the cranks.
      const GEAR_RATIO = 2.4;
      const CRANK_SPEED = -1.5; // rad/s (negative = forward-rolling direction)
      group.userData.tick = (dt: number) => {
        const dCrank = CRANK_SPEED * dt;
        crank.rotation.z -= dCrank;
        for (const p of pedals) p.rotation.z += dCrank; // keep platforms level
        const dWheel = dCrank * GEAR_RATIO; // synchronized: ω_wheel = ω_crank × ratio
        frontWheel.rotation.z -= dWheel;
        rearWheel.rotation.z -= dWheel;
      };
      return group;
    },
  },
  {
    id: 'm9-doppler',
    updatedAt: '2026-07-23',
    title: 'M9 Bayonet | Doppler Phase 2',
    subjectClass: 'object',
    blurb:
      'A CS2 M9 Bayonet rebuilt in code from a single broadside reference: the exact traced ' +
      'silhouette (scalloped sawteeth, thumb-hole, wedge-ground blade) with a single continuous ' +
      'flat-bar guard and a knurled worn-gunmetal grip. The Doppler Phase 2 finish (blue -> ' +
      'violet -> cyan smoke) is applied as reference-crop textures projected onto the blade and ' +
      'handle, over a code-generated studio environment. Live: a slow studio rock.',
    referenceImage: `${BASE}references/m9-doppler.jpg`,
    sourcePath: 'src/demos/m9-doppler/createM9DopplerModel.ts',
    sourceUrl: `${REPO}/src/demos/m9-doppler/createM9DopplerModel.ts`,
    generatedWith: 'img2threejs v1.3',
    author: 'kokorolx',
    authorUrl: 'https://github.com/kokorolx',
    status: 'final',
    cameraPosition: [0.4, 1.5, 5.2],
    cameraTarget: [0, 0, 0],
    cameraFov: 30,
    exposure: 1.42,
    // Own rig via installLights so the Viewer skips its default studio rig (the build was lit
    // by this single 3-point rig + the RoomEnvironment IBL at exposure 1.42).
    installLights: (scene) => {
      scene.add(createM9DopplerLookDevLights());
    },
    build: (scene) => {
      // Dark backdrop is owned by this demo's own module (runs after the Viewer, so it wins).
      scene.background = makeM9DopplerBackground();
      const group = createM9DopplerModel({ shadows: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'sony-wf1000xm3',
    updatedAt: '2026-07-16',
    title: 'Sony WF-1000XM3 Earbuds + Case',
    subjectClass: 'object',
    blurb:
      'The Sony WF-1000XM3 true-wireless earbuds and charging case rebuilt in code from a studio ' +
      'reference set, with the focus on colour & linework: a matte-black stadium case, a polished ' +
      'rose-gold/copper lid with an engraved SONY wordmark, a black inner lid framed by a copper ' +
      'rim and carrying the engraved spec plate (WF-1000XM3R / BC-WF1000XM3 / 5V), satin-graphite ' +
      'earbuds with copper SONY text + a copper mic ring, gold pogo contacts, and the L (grey) / ' +
      'R (red) + NFC markings. Live animation (looping): the lid opens, both buds rise while the ' +
      'case tilts, each bud spins a full turn, then they settle back into the wells and the lid closes.',
    referenceImage: `${BASE}references/sony-wf1000xm3.png`,
    sourcePath: 'src/demos/sony-wf1000xm3/createSonyWf1000xm3Model.ts',
    sourceUrl: `${REPO}/src/demos/sony-wf1000xm3/createSonyWf1000xm3Model.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [3.6, 2.7, 5.4],
    cameraTarget: [0, 0.55, 0],
    cameraFov: 35,
    build: (scene) => {
      scene.background = makeSonyBackground();
      const group = createSonyWf1000xm3Model({ shadows: true });
      scene.add(group);
      const lights = createSonyWf1000xm3LookDevLights();
      scene.add(lights);
      return group;
    },
  },
  {
    id: 'issaca-shotgun',
    updatedAt: '2026-07-16',
    title: 'ISSACA 12 Gauge Shotgun',
    subjectClass: 'object',
    blurb:
      'A stylized bullpup pistol-shotgun ("ISSACA / Bolton Dynamics") rebuilt in code from a ' +
      'studio reference sheet: a slate-gray painted receiver with ISSACA / 12-GAUGE stencils, a ' +
      'hatched Bolton Dynamics triangle and a US-flag decal; an amber marbled-bakelite handguard ' +
      'with four vent slots; a fluted satin-steel barrel with a slotted hex muzzle brake, knurled ' +
      'gas knob and angled front hand-stop; a hooded reflex red-dot with a blue-tinted lens and a ' +
      'glowing reticle; and a black polymer pistol grip + oval trigger guard. Live FIRING VFX: an ' +
      'additive muzzle flash + burst light, full-gun recoil kick with muzzle rise, a bolt that ' +
      'cycles, and a brass "RIFLED SLUG" shell that ejects and tumbles to the ground.',
    referenceImage: `${BASE}references/issaca-shotgun.png`,
    sourcePath: 'src/demos/issaca-shotgun/createIssacaShotgunModel.ts',
    sourceUrl: `${REPO}/src/demos/issaca-shotgun/createIssacaShotgunModel.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [1.9, 1.35, 3.5],
    cameraTarget: [-0.1, 0.5, 0],
    cameraFov: 32,
    build: (scene) => {
      scene.background = makeIssacaBackground();
      const group = createIssacaShotgunModel({ shadows: true });
      scene.add(group);
      const lights = createIssacaShotgunLookDevLights();
      scene.add(lights);
      return group;
    },
  },
  {
    id: 'gerber-knife',
    updatedAt: '2026-07-16',
    title: 'Gerber Paracord Knife',
    subjectClass: 'object',
    blurb:
      'A skeletonized full-tang tactical fixed-blade rebuilt in code from a single studio ' +
      'reference sheet: a modified-tanto blade with a black-oxide / stonewash PVD finish and a ' +
      'bright satin edge bevel, spine jimping, a "GERBER" wordmark + sword/anchor emblem and a ' +
      'vertical "3012863D" serial etch, a skeleton tang (forward lashing slot, ricasso hole) that ' +
      'tapers into a faceted hex pommel, all wrapped in ~13 turns of bright orange kernmantle ' +
      'paracord with a woven herringbone braid, finished by an overhand knot and two melted-tip ' +
      'tails. Live: a slow studio rock so the stonewash + cord weave catch travelling highlights.',
    referenceImage: `${BASE}references/gerber-knife.png`,
    sourcePath: 'src/demos/gerber-knife/createGerberKnifeModel.ts',
    sourceUrl: `${REPO}/src/demos/gerber-knife/createGerberKnifeModel.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [0.35, 2.15, 6.7],
    cameraTarget: [-0.15, 0, 0],
    cameraFov: 30,
    build: (scene) => {
      scene.background = makeStudioBackground();
      const group = createGerberKnifeModel({ shadows: true });
      scene.add(group);
      const lights = createGerberKnifeLookDevLights();
      scene.add(lights);
      return group;
    },
  },
  {
    id: 'doraemon-house',
    updatedAt: '2026-07-16',
    title: 'Doraemon House (isometric diorama)',
    subjectClass: 'object',
    blurb:
      'An isometric residential-diorama scene rebuilt in code from a single hand-illustrated ' +
      'reference: an interlocking cluster of cream stucco volumes under bright red ribbed gable ' +
      'roofs with cream ridge/eave trim, a rooftop antenna, blue-glass windows, a strawberry ' +
      'plaque, wood front door + purple garage door. Nobita sits on the top ridge and Doraemon ' +
      'lies on a lower slope; a cinder-block perimeter wall with wood slat gates rings a green ' +
      'lawn with rounded trees, two concrete utility poles carry street-lamp heads and a web of ' +
      'overhead wires, and a trash can sits on the yellow-lined asphalt road. Live: swaying ' +
      'canopies, twinkling dusk windows, a gentle bob on the characters.',
    referenceImage: `${BASE}references/doraemon-house.png`,
    sourcePath: 'src/demos/doraemon-house/createDoraemonHouseModel.ts',
    sourceUrl: `${REPO}/src/demos/doraemon-house/createDoraemonHouseModel.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [19, 15.5, 19],
    cameraTarget: [-0.2, 1.3, 0],
    cameraFov: 23,
    build: (scene) => {
      scene.background = makeSkyTexture();
      const group = createDoraemonHouseModel({ shadows: true });
      scene.add(group);
      const lights = createDoraemonHouseLookDevLights();
      scene.add(lights);
      return group;
    },
  },
  {
    id: 'warhauler',
    updatedAt: '2026-07-16',
    title: 'War-Hauler "SECTOR 07"',
    subjectClass: 'object',
    blurb:
      'A heavy armored 6-wheeled bulldozer-hauler rebuilt in code from a single isometric ' +
      'reference: gold brass cab (star, ACCESS PANEL, hazard lip, LED strip, twin slit ' +
      'headlights, corrugated exhaust), oxidized green-teal engine box, a riveted plow with ' +
      'five polished-steel claw blades, and six tyres with glowing red reactor hubs. ' +
      'Live VFX: exhaust smoke, a travelling glint across the blades, and rolling wheels.',
    referenceImage: `${BASE}references/warhauler.png`,
    sourcePath: 'src/demos/warhauler/createWarHaulerModel.ts',
    sourceUrl: `${REPO}/src/demos/warhauler/createWarHaulerModel.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [-4.7, 2.7, -5.2],
    cameraTarget: [0, 0.95, -0.2],
    cameraFov: 33,
    build: (scene) => {
      // dark, cinematic environment to match the concept-sheet shading
      scene.background = new THREE.Color(0x0c0d11);
      scene.fog = new THREE.Fog(0x0c0d11, 11, 26);
      const group = createWarHaulerModel({ shadows: true });
      scene.add(group);
      const lights = createWarHaulerLookDevLights();
      scene.add(lights);
      return group;
    },
  },
  {
    id: 'crown-chest',
    updatedAt: '2026-07-16',
    title: 'Crowned Loot Chest',
    subjectClass: 'object',
    blurb:
      'A chunky rounded-bevel loot chest rebuilt in code from a single 3/4 reference photo: ' +
      'purple-to-teal glossy enamel gradient, eight gold corner brackets, and an emissive crown emblem.',
    referenceImage: `${BASE}references/crown-chest.png`,
    sourcePath: 'src/demos/crown-chest/createCrownChestModel.ts',
    sourceUrl: `${REPO}/src/demos/crown-chest/createCrownChestModel.ts`,
    generatedWith: 'img2threejs v1.2',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'placeholder',
    cameraPosition: [-0.95, 0.5, 2.55],
    cameraTarget: [0, -0.05, 0],
    cameraFov: 38,
    build: (scene) => {
      const group = createCrownChestModel();
      scene.add(group);
      return group;
    },
  },
  {
    id: 'talon-doppler-ruby',
    updatedAt: '2026-08-08',
    title: '★ Talon Knife | Doppler Ruby (Factory New)',
    subjectClass: 'object',
    blurb:
      'A CS2 Talon Knife rebuilt in code from two admitted broadside references. The silhouette is '
      + 'traced, not eyeballed: one fixed image→world mapping puts the outline at 2.400 world units '
      + 'long and aspect 2.884:1 against the reference\'s measured 2.885:1, with 5 raked ratchet '
      + 'sawteeth at their measured irregular pitches, 3 graduated through-holes as real openings, '
      + 'two finger choils and a closed ring whose bore circularity is 0.986. The blade is a '
      + 'variable-thickness loft — full stock at the spine grinding to a near-zero apex — because a '
      + 'constant-thickness extrude reads as a toy cutout the moment it turns. Steel runs as ONE body '
      + '(blade → tang → ring); a Talon has no crossguard, so none is invented. Grip is a three-panel '
      + 'ivory scale with 7 brass through-pins per side at measured positions, a brass-rimmed rosette '
      + 'over a neutral-grey inlay, and two spacer strips of which the aft one is raked 12°. The '
      + 'Doppler Ruby finish is the reference\'s own de-lit pixels projected through the traced '
      + 'mapping, never a procedural swirl. Rendered under AgX: the measured peak ruby is '
      + 'rgb(245,56,65) with the red channel already clipped in the source, and ACES turns that pink. '
      + 'Live: a looping 9s talon spin about the finger-ring axis — an anodized finish only resolves '
      + 'in motion. Every thickness value is an inference; both references are broadside.',
    referenceImage: `${BASE}references/talon-doppler-ruby.webp`,
    sourcePath: 'src/demos/talon-doppler-ruby/createTalonDopplerRubyModel.ts',
    sourceUrl: `${REPO}/src/demos/talon-doppler-ruby/createTalonDopplerRubyModel.ts`,
    generatedWith: 'img2threejs v1.4.4 · cs2-knife-v1 adapter · talon subtype · reference-projection / image-only',
    prompt:
      'Rebuild the subject in this image as a procedural Three.js model. Hold proportions and '
      + 'silhouette to the reference; enumerate the identity-defining details first and drop any '
      + 'detail you cannot place on a real component instead of faking it. Derive the finish class '
      + 'and gradient stops from the reference pixels, not from memory, and flag any colour that '
      + 'will not survive tone-mapping. Expose pivots and sockets for whatever should move, plus a '
      + 'userData.tick for a looping idle animation.',
    author: 'kokorolx',
    authorUrl: 'https://github.com/kokorolx',
    status: 'final',
    // Matches the solved reference framing: fov 14 at distance 5.6 gives a 2.445-wide frame, so
    // the 2.400-long knife fills 98.2% of width against the reference's measured 98.4%.
    cameraPosition: [0, 0, 5.6],
    cameraTarget: [0, 0, 0],
    cameraFov: 14,
    // Pinned so a geometry change cannot reframe the review shot and contaminate the silhouette
    // metric. Derived, not tuned: the traced model is 2.409 wide, and filling 98.4% of frame
    // width (the reference's measured fill) at fov 14 on a 16:9 frame needs
    // d = (2.409/0.984) / (2*tan(7deg)*16/9) = 5.61. Target y = 0.002 is the traced bbox centre.
    // y = 0.0418, not 0.002: the reference's subject bbox is centred at 0.5281 of image height,
    // NOT at the image centre, so centring the model in frame leaves it 26px high. Measured, that
    // offset alone held raw silhouette IoU at 0.736 while a pure 26px translation lifted it to
    // 0.965 — a framing error masquerading as a shape error. 26/900 * frameHeight(1.3775) = 0.0398.
    capturePinnedCamera: {
      front: {
        position: [0, 0.0418, 5.61], target: [0, 0.0418, 0], fov: 14, near: 5.0, far: 6.4,
      },
      back: {
        position: [0, 0.0418, -5.61], target: [0, 0.0418, 0], fov: 14, near: 5.0, far: 6.4,
      },
    },
    accent: '#f53841',
    backgroundGradient: { inner: '#20101a', outer: '#050307' },
    exposure: 0.7,
    environmentIntensity: 1.0,
    // MEASURED, not assumed. The registry documents 'agx' as the operator a Ruby-Doppler blade
    // needs, and that is right for a PROCEDURAL Doppler whose colour comes from environment
    // reflection. This build takes the projection route, so the de-lit plate already carries the
    // finished appearance and the best operator is the one that transforms it least. A 16-way
    // sweep (4 operators x 4 exposures) scored the blade's ruby median against the reference:
    //   neutral@0.70  rgb(135, 20, 25)  dV  +8  dS +10   <- chosen
    //   neutral@0.85  rgb(148, 26, 31)  dV +21  dS  +3
    //   aces@0.70     rgb(151, 34, 41)  dV +24  dS -14
    //   agx@1.15      rgb(177, 90, 85)  dV +50  dS -79   <- worst of all 16
    // reference is rgb(127, 24, 27). AgX desaturates high-chroma values toward white as part of
    // its highlight rolloff, which is exactly wrong when the chroma IS the reference data.
    toneMapping: 'neutral',
    installLights: (scene) => {
      scene.add(createTalonDopplerRubyLookDevLights());
    },
    build: (scene) => {
      scene.background = makeTalonDopplerRubyBackground();
      const group = createTalonDopplerRubyModel({ shadows: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'girl-character-3',
    updatedAt: '2026-08-24',
    title: 'Dual-Sword Warrior — Procedural Character',
    subjectClass: 'character',
    // A figure has a front, a back and two profiles that read differently, and the rebuild is being
    // judged on all four. Turning is the default here for that reason; the toolbar can stop it.
    turntable: true,
    blurb:
      'No GLB, no image, no mesh file is fetched at runtime: each of the reference\u2019s 31 parts is '
      + 'rebuilt offline as a signed distance field splatted from that part\u2019s own point cloud, '
      + 'contoured with Surface Nets, and reduced by quadric-error edge collapse to the reference\u2019s '
      + 'EXACT triangle count \u2014 1,599,896 in total and part for part, none off by one. A uniform '
      + 'grid cannot land on that count and cannot hold a face either: at the head\u2019s 75,294 '
      + 'triangles it is 3.5 mm, and an eyelid\u2019s relief is 1.6 mm. So the field is contoured '
      + 'finer than the budget and the error metric decides where the triangles go, which is what puts '
      + 'them on the nose and the lids instead of the cheek. The reference\u2019s own texture '
      + 'coordinates are transferred onto the rebuilt triangles \u2014 per TRIANGLE, because its atlas '
      + 'is cut into islands and 17.7% of its head vertices are seam duplicates \u2014 so its colour, '
      + 'normal and metallic-roughness maps are read at their own resolution instead of averaged onto '
      + 'vertices. That is what an iris needs: at a fixed triangle count, per-vertex colour is strictly '
      + 'less resolution than a texture. Measured against the reference: area-weighted silhouette IoU '
      + '0.963, surface noise 1.25x, and every one of the twelve regions within 5% on luminance, ten of '
      + 'them within 3%. Rigged on 22 authored bones \u2014 the reference has no '
      + 'skeleton at all \u2014 with a procedural idle: a 4-second breath, a lagged ponytail spring, a '
      + 'travelling hem wave and an irregular blink \u2014 and nothing else: there is no action clip to '
      + 'strike a pose that would hide the surface being shown. The camera turntable carries every side '
      + 'past instead; drag to take it over, and the toolbar stops it. Add ?sdf=0 to rebuild every part '
      + 'from measured cross-sections instead, at the identical triangle count.',
    referenceImage: `${BASE}references/girl-character-3/ed-pantera-11.jpg`,
    // Measured from a GLB, not from photographs -- which is what lets this demo state a per-part triangle
    // count and be held to it. The thumbnail is a render OF that model, so it needs saying explicitly.
    referenceKind: 'model',
    // The heaviest stream in the gallery: 24.5 MB of encoded mesh plus 4.1 MB of texture. Without a
    // prewarm the page shows the cross-section loft first and then visibly swaps to the real surfaces.
    prewarm: prewarmGirlCharacter3,
    referenceUrl: 'https://hyper3d.ai/workspace/rodin/b0d3a7bb-86d4-45dd-b93b-2d45316cdade',
    sourcePath: 'src/demos/girl-character-3/createGirlCharacter3Model.ts',
    sourceUrl: `${REPO}/src/demos/girl-character-3/createGirlCharacter3Model.ts`,
    generatedWith: 'img2threejs v1.5.1 - implicit surfaces decimated to the reference count',
    author: 'Hoai Nho',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    cameraPosition: [0, 1.05, 3.15],
    cameraTarget: [0, 0.92, 0],
    cameraFov: 32,
    accent: '#d8d3c7',
    backgroundGradient: { inner: '#3a3a3d', outer: '#232326' },
    exposure: 1.06,
    environmentIntensity: 1.15,
    toneMapping: 'aces',
    installLights: (scene) => {
      scene.add(createGirlCharacter3LookDevLights());
    },
    build: (scene) => {
      const group = createGirlCharacter3Model({
        castShadow: true,
        receiveShadow: true,
        // Closed over the scene the viewer actually draws, so it keeps working across the model's own
        // code-split rebuild. `Viewer.start` publishes the rate; 15 deg/s is its default, so a nominal
        // turntable reads as 1.
        ambient: () => Math.min(1.5, ((scene.userData as { turntableRate?: number }).turntableRate ?? 0) / 15),
      });
      scene.add(group);
      return group;
    },
  },
];

/**
 * The gallery, newest first.
 *
 * Sorted here so every consumer -- the workbench filmstrip, the drawers, the router -- agrees on one
 * order. `sort` is stable in every engine this ships to, so exhibits sharing a date keep the order they
 * were authored in rather than shuffling between builds.
 */
export const demos: DemoEntry[] = [...authored]
  .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

export function getDemo(id: string): DemoEntry | undefined {
  return demos.find((demo) => demo.id === id);
}
