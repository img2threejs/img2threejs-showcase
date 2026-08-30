import * as THREE from 'three';
import { MONSTER_1_CLIPS } from './createMonster1Model';
import { buildRiggedModel, type RiggedModel } from './meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from './surfaceData.high';
import { RIG } from './rigData';
import { measureRigFrame } from './rigFrame';
import { createSockets } from './sockets';
import { createAnimator, type Animator } from './animator';
import { createRoblinLightRig, type LightRig } from './lighting';
import { createStage } from './stage';
import { VfxSystem } from './vfx/vfxSystem';
import { createSkills, createAmbientAura, footstepEffect, type Skill } from './skills';
import { createFootstepWatcher } from './footsteps';
import { createLimbMotion } from './motion';
import { createLimbTrails } from './vfx/limbTrails';
import { Swarm } from './vfx/swarm';
import { scanCues, formatCueScan } from './cueScan';
import { VFX, paletteReport } from './palette';
import { probeClips, formatProbeReport } from './clipProbe';

/**
 * Roblin — a goblin skirmisher, rigged and armed.
 *
 * The measured surface, the 41-bone rig, the skin weights and all 16 clips came out of the
 * img2threejs playground as code and are used unmodified (`createMonster1Model.ts`, `meshCodec.ts`,
 * `rigData.ts`, `surfaceData.high.ts`). Everything else in this folder was authored on top:
 *
 *   palette.ts    colours measured from the reference photo AND the model's own vertex colours
 *   rigFrame.ts   the body axes, measured from named bones (the spec is wrong about the facing)
 *   sockets.ts    ten sockets on real bones — the export shipped none
 *   animator.ts   cross-fades, one-shots that return, cues on the mixer's own clock
 *   lighting.ts   a light rig in the character's own palette
 *   vfx/          a hand-written effect layer: particles, ribbons, shockwaves, projectiles
 *   clipProbe.ts  Gate R1 — measures whether each clip actually moves the skin
 *
 * The full write-up is docs/showcases/roblin-stage-r.md.
 *
 * ONE NOTE ON THE LOOK. The standalone build of this showcase renders through an UnrealBloomPass,
 * which is what turns an emissive colour into a light source to the eye. The gallery viewer renders
 * directly with no post-processing, so the effects here lean harder on additive blending and on the
 * travelling point lights, which do not need a bloom pass to read.
 */

export interface RoblinRuntime {
  group: THREE.Group;
  animator: Animator;
  skills: readonly Skill[];
  lights: LightRig;
  vfx: VfxSystem;
}

/** Gate R1 is printed once per session, not once per build. */
let gateReported = false;

/**
 * Build the rigged shell.
 *
 * The standalone package reaches this through `prewarmMonster1()` + `createMonster1Rigged()`, which
 * pull the level of detail from a dynamic import so a phone never downloads the desktop tier. The
 * gallery cannot use that path: `build()` is synchronous by contract and runs BEFORE `prewarm()`
 * resolves, so a dynamic level is simply not there yet — the first version of this demo threw
 * "call prewarmMonster1() and await it" on every direct page load and put nothing in the scene.
 *
 * So the level is imported statically here instead, and the demo declares no `prewarm` at all. The
 * cost is honest and worth naming: `surfaceData.high` (1.8 MB) joins `rigData` (9.4 MB, already
 * static through the generated factory) in the main chunk rather than a lazy one. This model has
 * exactly one level, so there was never a cheaper tier to defer.
 */
function buildRigged(): RiggedModel {
  return buildRiggedModel(SURFACE_MODEL, SURFACE_STREAM, RIG, {
    castShadow: true,
    receiveShadow: true,
  });
}

/**
 * The action list the gallery's animation panel renders.
 *
 * The three skills come first because they are the point of this demo, then locomotion, then the
 * raw clips. Everything is a real embedded clip; nothing here is procedural.
 */
const CLIP_LABELS: Record<string, string> = {
  'preset:biped:idle': 'Idle',
  'preset:biped:standing_relax': 'Stand',
  'preset:biped:run_upstairs': 'Sprint',
  'preset:biped:defeat_03': 'Defeat',
  'preset:biped:front_kick_01': 'Kick 1',
  'preset:biped:front_kick_02': 'Kick 2',
  'preset:biped:box_01': 'Box 1',
  'preset:biped:box_03': 'Box 3',
  'preset:biped:dance_01': 'Dance 1',
  'preset:biped:dance_02': 'Dance 2',
  'preset:biped:dance_03': 'Dance 3',
  'preset:biped:dance_04': 'Dance 4',
  'preset:biped:dance_06': 'Dance 6',
};

/**
 * Build the demo.
 *
 * The SCENE is needed, not just the group: the light rig, the stage and the effect layer all have
 * to sit OUTSIDE the returned group. The group yaws during the sprint, so lights parented to it
 * would swing with the figure and the stage would spin under it. Keeping the returned group to the
 * character alone also keeps the gallery's parts inspector honest — a shockwave ring and a ground
 * disc are not parts of the model. The Viewer disposes the whole scene between demos, so nothing
 * added here outlives the demo.
 */
export function createRoblinModel(scene: THREE.Scene): THREE.Group {
  const rigged = buildRigged();
  const group = new THREE.Group();
  group.name = 'roblin';
  group.add(rigged.group);
  group.updateMatrixWorld(true);

  const frame = measureRigFrame(rigged.mesh);
  const sockets = createSockets(frame);

  // Gate R1 runs on the live model before the animator touches the mixer, and leaves the skeleton
  // in bind pose behind it. A clip that exists is not a clip that runs.
  if (!gateReported) {
    gateReported = true;
    const report = probeClips(rigged.mesh, rigged.clips, { figureHeight: frame.figureHeight });
    const style = report.failed || report.unevaluated ? 'color:#f68e23' : 'color:#c8ff3d';
    console.groupCollapsed(
      `%cRoblin — Gate R1: ${report.passed}/${report.results.length} clips measured`,
      style,
    );
    for (const line of formatProbeReport(report)) console.log(line);
    console.log('');
    for (const line of paletteReport()) console.log(line);
    for (const line of frame.log) console.log(line);
    for (const line of sockets.log) console.log(line);
    console.groupEnd();

    // Strike times for the combat clips, found by seeking rather than guessed. The cue numbers in
    // skills.ts came from this scan; running it here means a clip change cannot silently
    // invalidate them without the console saying so.
    console.groupCollapsed('%cRoblin — measured strike cues (seek scan)', 'color:#c8ff3d');
    for (const line of formatCueScan(scanCues(rigged.mesh, rigged.clips, sockets, frame, {
      sockets: ['effect:cast-primary', 'effect:cast-secondary', 'attachment:step-l', 'attachment:step-r'],
    }))) console.log(line);
    console.groupEnd();
  }

  const lights = createRoblinLightRig(frame);
  const stage = createStage(frame);
  // `venom` rather than `toxic` for the floor pool: at full brightness the toxic hue reads as a
  // lamp pointed at the floor instead of as a pool the figure stands in.
  const vfx = new VfxSystem(frame.figureHeight, new THREE.Color(VFX.venom.value));
  const animator = createAnimator(rigged, 'preset:biped:idle');
  const motion = createLimbMotion(sockets, frame);
  // `trails` is created below and the skills need to recolour it while a cast runs, so the hook is
  // a late binding rather than a construction-order rearrangement that would leave the trails
  // without a motion tracker to read.
  let trailsRef: { tintHands(h: THREE.Color, t: THREE.Color, s: number): void } | null = null;
  const skills = createSkills({
    frame, sockets, animator, vfx, lights, groundY: 0, root: group, motion,
    tintTrails: (head, tail, seconds) => trailsRef?.tintHands(head, tail, seconds),
  });

  // Speed-driven wakes on both hands and both feet, keyed to nothing but the measured limb speed,
  // so all sixteen clips get the streaks their own motion earns. Hands carry the signature hue and
  // feet the leather one, so a kick never looks like a cast.
  const trails = createLimbTrails(
    [
      { socketId: 'effect:cast-primary', colour: VFX.spore.value, tail: VFX.venom.value, spark: VFX.spore.value, sparkEnd: VFX.venom.value, width: 0.07, quiet: 0.5, loud: 2.6, sparkRate: 110 },
      { socketId: 'effect:cast-secondary', colour: VFX.spore.value, tail: VFX.venom.value, spark: VFX.spore.value, sparkEnd: VFX.venom.value, width: 0.07, quiet: 0.5, loud: 2.6, sparkRate: 110 },
      { socketId: 'attachment:step-l', colour: VFX.ember.value, tail: VFX.emberDeep.value, spark: VFX.ember.value, sparkEnd: VFX.emberDeep.value, width: 0.058, quiet: 0.7, loud: 3.2, sparkRate: 75 },
      { socketId: 'attachment:step-r', colour: VFX.ember.value, tail: VFX.emberDeep.value, spark: VFX.ember.value, sparkEnd: VFX.emberDeep.value, width: 0.058, quiet: 0.7, loud: 3.2, sparkRate: 75 },
    ],
    sockets, motion, vfx, frame.figureHeight,
  );
  trailsRef = trails;

  // The flies. Roblin sleeps in a swamp in rotting leather; a loose swarm orbiting him says more
  // about the character than any amount of glow does. `venom` rather than a bright hue on purpose —
  // gnats should be almost invisible against the backdrop and only read where they cross the figure.
  const swarm = new Swarm(90, frame.figureHeight * 0.006, new THREE.Color(VFX.venom.value));
  const aura = createAmbientAura({ frame, sockets, vfx });
  const footsteps = createFootstepWatcher(
    [sockets.get('attachment:step-l'), sockets.get('attachment:step-r')],
    frame.figureHeight,
    0,
  );

  // Note these are added to the SCENE, not to `group` — see the comment on this function. They are
  // also not parented into the skeleton: the skinned mesh carries the rig's normalisation scale of
  // 2.113, and anything under a bone inherits it, so a 10cm spark would become a 21cm one.
  // The character group is added here too, alongside the rest: `build` owns putting its own model
  // in the scene — the registry contract is "adds the model and returns the group", not "returns a
  // group for the caller to add".
  scene.add(group, lights.group, stage.group, vfx.root, trails.group, swarm.points);

  const stepSockets = ['attachment:step-l', 'attachment:step-r'];
  const core = new THREE.Vector3();
  // Ribbon trails are extruded against the view direction, so they need the camera position. The
  // gallery's tick signature does not hand one over and the camera is not in the scene graph, so
  // the demo takes it from the viewer through `sculptRuntime` — see `setCamera` below. Until that
  // is called the trails extrude against the origin, which is still a valid direction.
  const cameraPosition = new THREE.Vector3();
  const travelDirection = new THREE.Vector3();
  const travelVelocity = new THREE.Vector3();
  const travelled = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let plantHeight = 0;
  let auraPulse = 1;

  const actions = [
    ...skills.map((s) => ({ id: s.id, label: s.label, loop: false })),
    { id: 'sprint', label: 'Sprint', loop: true },
    ...MONSTER_1_CLIPS.filter((c) => CLIP_LABELS[c] && c !== 'preset:biped:run_upstairs')
      .map((c) => ({ id: c, label: CLIP_LABELS[c], loop: true })),
  ];

  let active = 'idle';
  const listeners = new Set<(a: string) => void>();
  const announce = (next: string): void => {
    active = next;
    for (const listener of listeners) listener(next);
  };

  const skillById = new Map(skills.map((s) => [s.id, s]));

  const animationController = {
    actions,
    get active() { return active; },
    play(name: string) {
      const skill = skillById.get(name);
      if (skill) {
        skill.cast();
        announce(name);
        return;
      }
      if (name === 'sprint') {
        animator.play('preset:biped:run_upstairs', 0.3);
        announce('sprint');
        return;
      }
      if (animator.play(name, 0.4)) announce(name);
    },
    stop() {
      animator.play('preset:biped:idle', 0.35);
      announce('idle');
    },
    update(delta: number) { animator.update(delta); },
    subscribe(listener: (a: string) => void) {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };

  group.userData.sculptRuntime = {
    animationController,
    /** Lets a host hand the demo its camera so ribbon trails face the viewer. */
    setCamera: (camera: THREE.Camera) => camera.getWorldPosition(cameraPosition),
    pivots: rigged.group.userData.pivots ?? {},
    actionAnchors: Object.fromEntries(
      [...sockets.all.values()].map((s) => [s.def.id, s.worldPosition().toArray()]),
    ),
  };

  // The gallery hands `tick` a DELTA first. A mixer integrates what it is handed; give it elapsed
  // seconds and it fast-forwards by the whole session on every frame.
  group.userData.tick = (delta: number): void => {
    const dt = Math.min(delta, 1 / 20);
    const sprinting = animator.current === 'preset:biped:run_upstairs';

    if (sprinting) {
      // Roblin runs IN PLACE and the floor slides underneath. Carrying the figure across the stage
      // walks it out of a light rig anchored to the origin and off the lit part of the stage disc.
      //
      // GROUND-PROJECTED: the measured forward axis is (0.997, 0.069, -0.029) and carries a small
      // upward component, because the bind pose's hand-to-hand baseline is not perfectly level.
      // Used raw as a travel direction it lifts the figure about 0.12 units per second.
      group.rotateY(dt * 0.35);
      travelDirection.copy(frame.forward).setY(0).normalize().applyAxisAngle(worldUp, group.rotation.y);
      const speed = frame.figureHeight * 1.15;
      travelled.addScaledVector(travelDirection, dt * speed);
      stage.scroll(travelled.x, travelled.z);
      travelVelocity.copy(travelDirection).multiplyScalar(-speed);
    } else {
      travelVelocity.set(0, 0, 0);
      // Ease the yaw back so a long sprint does not leave the figure permanently turned away.
      if (Math.abs(group.rotation.y) > 1e-4) {
        group.rotation.y *= Math.max(0, 1 - dt * 1.6);
        if (Math.abs(group.rotation.y) < 1e-3) group.rotation.y = 0;
      }
    }

    animator.update(dt);
    group.updateMatrixWorld(true);
    // Velocities and pointing axes are read AFTER the pose has advanced and matrices are current;
    // every aim in the effect layer comes from here.
    motion.update(dt);

    // Ground the climb. `preset:biped:run_upstairs` is a STAIR CLIMB — the only locomotion clip the
    // rig ships — and its root motion lifts the figure clear of a flat floor. The lowest toe is
    // measured every frame and the figure dropped by a slowly-relaxing running minimum of it;
    // using the instantaneous minimum would pin the lowest foot down and flatten the airborne phase.
    const toeHeight = Math.min(
      sockets.get(stepSockets[0]).worldPosition().y,
      sockets.get(stepSockets[1]).worldPosition().y,
    ) - group.position.y;
    plantHeight = Math.min(toeHeight, plantHeight + dt * frame.figureHeight * 0.9);
    group.position.y += (-plantHeight - group.position.y) * Math.min(1, dt * 6);
    group.updateMatrixWorld(true);

    auraPulse = animator.busy ? 2.6 : Math.max(1, auraPulse - dt * 2);
    aura.update(dt, auraPulse);

    swarm.setBounds(
      sockets.get('effect:core').worldPosition(),
      new THREE.Vector3(frame.figureHeight * 0.42, frame.figureHeight * 0.5, frame.figureHeight * 0.42),
    );
    swarm.stir(Math.min(1, trails.intensity * 0.9 + (animator.busy ? 0.5 : 0)));
    swarm.update(dt);

    footsteps.update(dt, (step) => {
      // The dust inherits the floor's motion, not the figure's, so it is left behind exactly the
      // way it would be if Roblin were the thing moving.
      footstepEffect(
        vfx, step.at, step.impactSpeed, frame.figureHeight, frame.up, 0, step.clearance,
        travelVelocity, motion.velocity(step.id), motion.axis(step.id),
      );
    });

    sockets.get('effect:core').worldPosition(core);
    vfx.glow.mesh.position.set(core.x, 0.004, core.z);
    vfx.glow.setIntensity(animator.busy ? 1.0 : 0.62);

    lights.update(dt);
    trails.update(dt, cameraPosition);
    vfx.update(dt, cameraPosition);
  };

  if (!animator.busy) announce('idle');
  return group;
}

/**
 * Deliberately empty.
 *
 * `installLights` exists so the Viewer skips its default studio rig, and that is all it is used for
 * here. Roblin's rig has to be built from the MEASURED body frame, and measuring that frame needs
 * the bound skeleton — which does not exist until `build` runs. Doing the work here would mean
 * decoding all 113,338 triangles a second time just to read four numbers off them, so the rig is
 * created inside `build` and added to the same scene.
 */
export function installRoblinLights(): void {}
