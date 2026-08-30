// Registry entry for img2threejs-showcase.
//
// This is the RIGGED entry, not the static one the playground exports by default: the model is one
// skinned shell driven by an AnimationMixer, with the hand-written VFX layer attached to sockets
// measured on the rig's own bones.
//
// 1. copy src/*.ts (including src/vfx/) from this download into src/demos/monster-cute/
// 2. copy evidence/*.json alongside them — characterProfile.ts imports the measurements directly
// 3. copy showcase/reference.jpg to public/references/monster-cute.jpg
// 4. add these imports near the top of src/demos/registry.ts:
import {
  createMonsterCuteRigged,
  prewarmMonsterCute,
} from './monster-cute/createMonsterCuteModel';
import { createAnimator } from './monster-cute/animation';
import { createMonsterCuteVfx } from './monster-cute/vfx';
import { createMonsterCuteStageLights } from './monster-cute/lighting';
import { frontCamera } from './monster-cute/characterProfile';

// 5. and this entry to the `demos` array:
  {
    id: 'monster-cute',
    title: 'Monster Cute',
    subjectClass: 'character',
    blurb:
      'A cute blue horned monster measured from one reference image by the img2threejs playground, '
      + 'then taken through Stage R of the 1.5.2 rigging pipeline: 41 real bones, 26 embedded clips '
      + 'all passing Gate R1 at 5.96e-8, and a hand-written VFX layer anchored to sockets measured '
      + "out of the character's own vertices. Effect and light colours are sampled off the fur, "
      + 'belly, horns and wristbands.',
    referenceImage: `${BASE}references/monster-cute.jpg`,
    sourcePath: 'src/demos/monster-cute/createMonsterCuteModel.ts',
    sourceUrl: `${REPO}/src/demos/monster-cute/createMonsterCuteModel.ts`,
    generatedWith: 'img2threejs playground · Tripo v3.1-20260211 measurement · GLB fast lane · 1.5.2 Stage R',
    author: 'Anonymous',
    authorUrl: 'https://github.com/img2threejs/img2threejs-showcase',
    status: 'placeholder',
    // Framing derived from the measured facing (+x), not from the export's camera, which points at
    // the character's back.
    ...(() => { const f = frontCamera(); return {
      cameraPosition: [f.position.x, f.position.y, f.position.z] as [number, number, number],
      cameraTarget: [f.target.x, f.target.y, f.target.z] as [number, number, number],
      cameraFov: f.fov,
    }; })(),
    installLights: (scene) => scene.add(createMonsterCuteStageLights().group),
    prewarm: () => prewarmMonsterCute('high').then(() => undefined),
    build: (scene) => {
      const rigged = createMonsterCuteRigged();
      const animator = createAnimator(rigged);
      const vfx = createMonsterCuteVfx(rigged);
      scene.add(rigged.group, vfx.group);
      animator.play('preset:biped:dance_01', 0);
      vfx.setClip('preset:biped:dance_01');
      // The gallery collects `userData.tick` itself. The mixer wants a DELTA; passing elapsed time
      // here makes every clip race away on the first frame.
      rigged.group.userData.tick = (dt: number, elapsed: number) => {
        animator.update(dt);
        vfx.update(dt, elapsed, scene.userData.camera as THREE.Camera);
      };
      return rigged.group;
    },
  },
