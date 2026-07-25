import * as THREE from 'three';
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
}

const BASE = import.meta.env.BASE_URL;
const REPO = 'https://github.com/hoainho/img2threejs-showcase/blob/main';

export const demos: DemoEntry[] = [
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
];

export function getDemo(id: string): DemoEntry | undefined {
  return demos.find((demo) => demo.id === id);
}
