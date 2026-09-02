import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createBackdrop, createGround, createMonsterTreeLights } from './lighting';
import { COSTUME_PIECES, PALETTE, SOCKETS } from './measured';
import { MONSTER_TREE_CAMERA, createMonsterTree, prewarmMonsterTree } from './model';
import { BEATS } from './poses';
import { SKILLS, SkillRunner, figureBounds } from './skills';
import { MonsterTreeVfx } from './vfx';

const app = document.getElementById('stage') as HTMLDivElement;
const status = document.getElementById('status') as HTMLParagraphElement;

async function main(): Promise<void> {
  status.textContent = 'decoding 115,350 measured triangles…';
  await prewarmMonsterTree();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(app.clientWidth, app.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Near-black. The backdrop, the ground and the ambient terms are all held down together so the
  // only things above the floor of the image are the figure and the light moving around it.
  scene.background = new THREE.Color(PALETTE.barkDark).convertSRGBToLinear().multiplyScalar(0.18);
  scene.environment = createBackdrop();
  scene.environmentIntensity = 0.30;

  const camera = new THREE.PerspectiveCamera(MONSTER_TREE_CAMERA.fov, app.clientWidth / app.clientHeight, 0.1, 100);
  camera.position.fromArray(MONSTER_TREE_CAMERA.position);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.fromArray(MONSTER_TREE_CAMERA.target);
  controls.enableDamping = true;
  controls.minDistance = 1.5;
  controls.maxDistance = 14;
  controls.maxPolarAngle = Math.PI * 0.52;

  const rig = createMonsterTree();
  scene.add(rig.group);

  // The skinned figure has to be posed once before anything measures it — a Box3 taken before the
  // first world-matrix walk describes the bind pose in the wrong space.
  scene.updateMatrixWorld(true);
  const bounds = figureBounds(rig);
  const height = bounds.getSize(new THREE.Vector3()).y;

  scene.add(createMonsterTreeLights(height));
  scene.add(createGround(height));

  const vfx = new MonsterTreeVfx(rig, bounds);
  scene.add(vfx.group);

  const runner = new SkillRunner(rig, vfx, 'idle');
  buildControls(runner);
  buildReadout(rig, height);

  let turntable = false;
  const spin = document.getElementById('spin') as HTMLInputElement;
  spin.addEventListener('change', () => { turntable = spin.checked; });

  addEventListener('resize', () => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    camera.aspect = app.clientWidth / app.clientHeight;
    camera.updateProjectionMatrix();
  });

  const clock = new THREE.Clock();
  let frames = 0;
  let sampled = 0;
  const fps = document.getElementById('fps') as HTMLSpanElement;

  const tick = (): void => {
    // Clamp the delta so a backgrounded tab does not resume by jumping the mixer several seconds
    // forward and skipping every cue in between.
    const dt = Math.min(clock.getDelta(), 0.1);
    rig.update(dt);          // DELTA, not elapsed — the mixer integrates it
    runner.update(dt);       // fires cues, drives the authored poses and any bone stretch
    rig.applyPose();         // ...solves those aims onto the skeleton, parents first
    rig.applyStretch();      // ...and the stretch has to follow, or it lands a frame late
    vfx.update(dt);
    if (turntable) rig.group.rotation.y += dt * 0.35;
    controls.update();
    renderer.render(scene, camera);

    frames += 1;
    sampled += dt;
    if (sampled >= 0.5) {
      fps.textContent = `${Math.round(frames / sampled)} fps · ${renderer.info.render.calls} draw calls · ${vfx.liveEffects} live effects`;
      frames = 0;
      sampled = 0;
    }
  };
  renderer.setAnimationLoop(tick);

  // Inspection handle. The claims this page makes about the rig — that the leather is four rigid
  // meshes, that the sockets sit on real bones — are only worth anything if they can be checked,
  // and checking them means being able to put the camera on a forearm and read the object tree.
  // `tools/measure-rig.mjs` proves the same things numerically; this is the visual counterpart.
  (window as unknown as Record<string, unknown>).monsterTree = {
    scene, camera, controls, rig, vfx, runner, beats: BEATS,
    // The renderer and the loop switch, so a review harness can STOP the demo driving itself,
    // step the animation to an exact frame and render that frame. Without it every inspection
    // screenshot is whatever the live loop happened to be showing a moment later.
    renderer,
    setLoop: (on: boolean) => renderer.setAnimationLoop(on ? tick : null),
    render: () => renderer.render(scene, camera),
  };

  status.textContent = '';
  status.hidden = true;
}

function buildControls(runner: SkillRunner): void {
  const host = document.getElementById('skills') as HTMLDivElement;
  for (const skill of SKILLS) {
    const button = document.createElement('button');
    button.textContent = skill.label;
    button.title = skill.measured;
    button.dataset.skill = skill.id;
    button.addEventListener('click', () => {
      runner.play(skill.id);
      for (const other of host.querySelectorAll('button')) other.classList.remove('on');
      button.classList.add('on');
      (document.getElementById('measured') as HTMLElement).textContent = `${skill.clip} — ${skill.measured}`;
    });
    if (skill.id === 'idle') button.classList.add('on');
    host.appendChild(button);
  }
  (document.getElementById('measured') as HTMLElement).textContent =
    `${SKILLS[0].clip} — ${SKILLS[0].measured}`;
}

function buildReadout(rig: ReturnType<typeof createMonsterTree>, height: number): void {
  const parts = document.getElementById('parts') as HTMLElement;
  const shellTris = (rig.shell.geometry.index?.count ?? 0) / 3;
  const rows = [
    `<tr><td>bark-shell</td><td>skinned, 41 bones</td><td>${shellTris.toLocaleString()}</td></tr>`,
    ...COSTUME_PIECES.map((p) => {
      const piece = rig.costume.find((c) => c.id === p.id);
      return `<tr><td>${p.id}</td><td>rigid · fit on ${piece?.fitSamples ?? 0} samples</td><td>${p.triangles.toLocaleString()}</td></tr>`;
    }),
  ];
  parts.innerHTML = rows.join('');

  const socketList = document.getElementById('sockets') as HTMLElement;
  socketList.innerHTML = SOCKETS
    .map((s) => `<tr><td>${s.id}</td><td>${s.bone}</td><td>${s.kind}</td><td>${s.samples}</td></tr>`)
    .join('');

  (document.getElementById('height') as HTMLElement).textContent = `${height.toFixed(3)} units`;
}

main().catch((error: unknown) => {
  status.hidden = false;
  status.textContent = `failed to build: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
});
