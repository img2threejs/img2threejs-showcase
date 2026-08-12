import * as THREE from 'three';
import { createLuxoraHotelModel } from './luxora-hotel/createLuxoraHotelModel';
import type { PinnedCaptureCamera } from '../scene';
import {
  createM9DopplerModel,
  createM9DopplerLookDevLights,
  makeM9DopplerBackground,
} from './m9-doppler/createM9DopplerModel';
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
  createTalonDopplerRubyModel,
  createTalonDopplerRubyLookDevLights,
  makeTalonDopplerRubyBackground,
} from './talon-doppler-ruby/createTalonDopplerRubyModel';
import {
  createLowPolyHumanoidLookDevLights,
  createLowPolyHumanoidModel,
} from './low-poly-humanoid/createLowPolyHumanoidModel';

export interface DemoEntry {
  /** route id, e.g. 'crown-chest' */
  id: string;
  title: string;
  subjectClass: 'object' | 'character';
  /** 1-2 sentences */
  blurb: string;
  referenceImage: string;
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
  status: 'placeholder' | 'final';
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
  /** Adds the model (and any demo-specific lights) to the scene, returns the group. */
  build: (scene: THREE.Scene) => THREE.Group;
  /** Whether this demo should offer the generic exploded-parts inspection view. */
  enableExplode?: boolean;
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

const BASE = import.meta.env.BASE_URL;
const REPO = 'https://github.com/hoainho/img2threejs-showcase/blob/main';

export const demos: DemoEntry[] = [
  {
    id: 'luxora-hotel',
    title: 'Luxora Low-Poly Hotel',
    subjectClass: 'object',
    blurb:
      'A code-only low-poly hotel diorama with a central tower, layered façades, pool deck, cars, landscaping, and warm room lights. Every visible surface and prop is generated from Three.js primitives and procedural materials.',
    referenceImage: `${BASE}references/luxora-hotel.jpg`,
    sourcePath: 'src/demos/luxora-hotel/createLuxoraHotelModel.ts',
    sourceUrl: `${REPO}/src/demos/luxora-hotel/createLuxoraHotelModel.ts`,
    generatedWith: 'img2threejs v1.5.0 · procedural hotel diorama',
    author: 'Faruq So',
    authorUrl: 'https://github.com/faruqso',
    status: 'final',
    cameraPosition: [32, 26, 35],
    cameraTarget: [0, 5.8, 0],
    cameraFov: 34,
    accent: '#b7d95a',
    backgroundGradient: { inner: '#e9efe1', outer: '#b5c48b' },
    exposure: 1,
    environmentIntensity: 0.85,
    toneMapping: 'aces',
    enableExplode: false,
    build: (scene) => {
      const group = createLuxoraHotelModel();
      scene.add(group);
      return group;
    },
  },
  {
    id: 'low-poly-humanoid',
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
    build: (scene) => {
      const group = createLowPolyHumanoidModel({ castShadow: true, receiveShadow: true });
      scene.add(group);
      return group;
    },
  },
  {
    id: 'awp-medusa-v2',
    title: 'AWP | Medusa (Minimal Wear) · V2 rebuild',
    subjectClass: 'object',
    blurb:
      'Procedural CS2 AWP rebuilt from the admitted front/back broadside references. The silhouette gate is met at IoU 0.9205 front / 0.9171 back against a 0.90 target, and the Medusa artwork is projected from the reference\'s own de-lit pixels through the capture camera the plates are registered to. Macro shell profiles, open thumbhole, receiver, constant-diameter barrel with a squared front-sight block and a crowned muzzle, scope with a corrected objective flare and U-clamp ring saddles, receiver-parented bolt, trigger group, magazine, hinge, independent springs, telescoping bipod legs, feet, fasteners, sockets and idle tick are separate physical components with 15 verified contact pairs. Interactive: fire for muzzle flash, tracer, ejecting casing, recoil and bolt cycle; deploy the splayed bipod; look through the scope to line up the electric-mouse mascot, then fire to trigger its lightning burst and hit the reticle.',
    referenceImage: `${BASE}front-medusa.webp`,
    sourcePath: 'src/demos/awp-medusa-v2/createAwpMedusaModelV2.ts',
    sourceUrl: `${REPO}/src/demos/awp-medusa-v2/createAwpMedusaModelV2.ts`,
    generatedWith: 'img2threejs V2 · custom AWP rifle adapter · blockout + projection + interactions complete',
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
];

export function getDemo(id: string): DemoEntry | undefined {
  return demos.find((demo) => demo.id === id);
}
