import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RobotRuntime } from './robotModel';

const WALK_SPEED = 1.34;
const RUN_SPEED = 3.4;

export const ROBOT_STREET_SKILLS = [
  { key: 1, sourcePrefix: 'box_01.001', label: 'Box 01' },
  { key: 2, sourcePrefix: 'box_02.001', label: 'Box 02' },
  { key: 3, sourcePrefix: 'box_03.001', label: 'Box 03' },
  { key: 4, sourcePrefix: 'front_kick_01.001', label: 'Front Kick 01' },
  { key: 5, sourcePrefix: 'front_kick_02.001', label: 'Front Kick 02' },
  { key: 6, sourcePrefix: 'Begin with your left foot forward', label: 'Muay Thai 01' },
  { key: 7, sourcePrefix: 'Begin in a left-leading guard', label: 'Muay Thai 02' },
  { key: 8, sourcePrefix: 'greet_01.001', label: 'US Greeting' },
  { key: 9, sourcePrefix: 'Stand upright with your feet close together, knees relaxed, bac', label: 'Gentleman' },
] as const;

export interface RobotStreetControls {
  readonly position: THREE.Vector3;
  beforeAnimation(delta: number): void;
  afterAnimation(delta: number): void;
  setPlayback(clipName: string | null): void;
  finishPlayback(): void;
  clearInput(): void;
  dispose(): void;
  getState(): { position: number[]; moving: boolean; clip: string | null; heldKeys: string[] };
}

interface StreetOptions {
  runtime: RobotRuntime;
  actor: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  canInteract: () => boolean;
  onMove: (clipIndex: number) => void;
  onRest: () => void;
  onSkill: (clipIndex: number) => void;
}

export function createRobotStreetControls(options: StreetOptions): RobotStreetControls {
  const { runtime, actor, camera, controls } = options;
  const resolve = (prefix: string): number => {
    const matches = runtime.clips.flatMap((clip, index) => clip.name.startsWith(prefix) ? [index] : []);
    if (matches.length !== 1) throw new Error(`Expected one native robot clip for ${prefix}; found ${matches.length}.`);
    return matches[0];
  };
  const walkIndex = resolve('walk.001');
  const runIndex = resolve('run.001');
  const skillIndices = ROBOT_STREET_SKILLS.map((skill) => resolve(skill.sourcePrefix));
  const hips = actor.getObjectByName('mixamorigHips');
  if (!hips) throw new Error('Native robot mixamorigHips bone is missing.');
  const basePosition = actor.position.clone();
  const baseQuaternion = actor.quaternion.clone();
  const baseScale = actor.scale.clone();
  const position = new THREE.Vector3(basePosition.x, 0, basePosition.z);
  const point = new THREE.Vector3();
  const hip = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const contactVelocity = new THREE.Vector3();
  const sampleVelocity = new THREE.Vector3();
  const navigationDelta = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const yawQuaternion = new THREE.Quaternion();
  forward.set(0, 0, 1).applyQuaternion(baseQuaternion);
  const baseHeading = Math.atan2(forward.x, forward.z);
  let yaw = 0;
  actor.updateWorldMatrix(true, true);
  const probes: { mesh: THREE.SkinnedMesh; vertex: number }[] = [];
  for (const mesh of runtime.meshes) {
    mesh.skeleton.update();
    const skinIndex = mesh.geometry.getAttribute('skinIndex');
    const skinWeight = mesh.geometry.getAttribute('skinWeight');
    for (const side of ['Left', 'Right']) {
      const ids = new Set(mesh.skeleton.bones.flatMap((bone, index) =>
        bone.name.startsWith(`mixamorig${side}`) && (bone.name.includes('Foot') || bone.name.includes('Toe')) ? [index] : []));
      const candidates: { vertex: number; x: number; y: number; z: number }[] = [];
      let bottom = Infinity;
      for (let vertex = 0; vertex < skinIndex.count; vertex++) {
        let influence = 0;
        for (let component = 0; component < 4; component++) {
          if (ids.has(skinIndex.getComponent(vertex, component))) influence += skinWeight.getComponent(vertex, component);
        }
        if (influence < 0.5) continue;
        mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);
        candidates.push({ vertex, x: point.x, y: point.y, z: point.z });
        bottom = Math.min(bottom, point.y);
      }
      const sole = candidates.filter((candidate) => candidate.y < bottom + 0.022);
      if (!sole.length) throw new Error(`No native ${side} sole probes found.`);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const candidate of sole) {
        minX = Math.min(minX, candidate.x); maxX = Math.max(maxX, candidate.x);
        minZ = Math.min(minZ, candidate.z); maxZ = Math.max(maxZ, candidate.z);
      }
      const grid = new Map<number, typeof sole[number]>();
      for (const candidate of sole) {
        const x = Math.min(5, Math.floor((candidate.x - minX) / Math.max(0.001, maxX - minX) * 6));
        const z = Math.min(11, Math.floor((candidate.z - minZ) / Math.max(0.001, maxZ - minZ) * 12));
        const key = x + z * 6;
        const prior = grid.get(key);
        if (!prior || candidate.y < prior.y) grid.set(key, candidate);
      }
      for (const candidate of grid.values()) probes.push({ mesh, vertex: candidate.vertex });
    }
  }
  if (!probes.length) throw new Error('Native robot has no skinned sole geometry.');
  const current = new Float64Array(probes.length * 3);
  const previous = new Float64Array(probes.length * 3);
  const previousWeights = new Float64Array(probes.length);
  let sampled = false;
  let airborneTime = 0;
  let clip: THREE.AnimationClip | null = null;
  let action: THREE.AnimationAction | null = null;
  let previousActionTime = 0;
  let keyboardMoving = false;
  let requestingMovement = false;
  let sprinting = false;
  let locked = false;
  let freshArrow = false;
  let disposed = false;
  const held = new Set<string>();
  const digits = new Set<string>();
  const isArrow = (key: string): boolean => key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
  const editable = (target: EventTarget | null): boolean => target instanceof Element
    && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const clearInput = (): void => {
    held.clear(); digits.clear(); freshArrow = false; sprinting = false;
    velocity.set(0, 0, 0); contactVelocity.set(0, 0, 0);
    sampled = false;
  };
  const setPlayback = (name: string | null): void => {
    clip = name === null ? null : runtime.clips.find((candidate) => candidate.name === name) ?? null;
    if (name !== null && !clip) throw new Error(`Unknown native robot clip: ${name}`);
    action = clip ? runtime.mixer.existingAction(clip) : null;
    keyboardMoving = requestingMovement;
    // The host can override a looping profile for a one-shot keyboard skill.
    locked = !requestingMovement && action?.loop === THREE.LoopOnce;
    freshArrow = false;
    sampled = false;
    airborneTime = 0;
    velocity.set(0, 0, 0); contactVelocity.set(0, 0, 0);
  };
  const keydown = (event: KeyboardEvent): void => {
    if (disposed || !options.canInteract() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || editable(event.target)) return;
    if (event.key === 'Shift') { sprinting = true; return; }
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    const number = match ? Number(match[1]) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
    if (number) {
      if (event.shiftKey) return;
      event.preventDefault();
      const token = event.code || event.key;
      if (event.repeat || digits.has(token)) return;
      digits.add(token);
      freshArrow = false;
      options.onSkill(skillIndices[number - 1]);
      return;
    }
    if (isArrow(event.key)) {
      event.preventDefault();
      sprinting = event.shiftKey;
      if (!event.repeat && !held.has(event.key)) { held.add(event.key); freshArrow = true; }
      return;
    }
  };
  const keyup = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') sprinting = event.shiftKey;
    if (!event.code.startsWith('Numpad')) held.delete(event.key);
    digits.delete(event.code || event.key);
  };
  const visibility = (): void => { if (document.hidden) clearInput(); };
  const focus = (event: FocusEvent): void => { if (editable(event.target)) clearInput(); };
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', clearInput);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('focusin', focus);

  return {
    position,
    beforeAnimation(delta) {
      if (disposed) return;
      actor.position.copy(basePosition);
      actor.quaternion.copy(baseQuaternion);
      actor.scale.copy(baseScale);
      desired.set(0, 0, 0);
      if (!options.canInteract()) { clearInput(); return; }
      const horizontal = Number(held.has('ArrowRight')) - Number(held.has('ArrowLeft'));
      const vertical = Number(held.has('ArrowUp')) - Number(held.has('ArrowDown'));
      const input = horizontal !== 0 || vertical !== 0;
      if (input && freshArrow) locked = false;
      if (action?.paused && !(input && freshArrow)) {
        velocity.set(0, 0, 0); contactVelocity.set(0, 0, 0); sampled = false;
        freshArrow = false;
        return;
      }
      if (input && !locked) {
        const moveIndex = sprinting ? runIndex : walkIndex;
        if (!keyboardMoving || clip !== runtime.clips[moveIndex] || action?.paused) {
          const vx = velocity.x, vz = velocity.z;
          requestingMovement = true;
          try { options.onMove(moveIndex); } finally { requestingMovement = false; }
          // Switching gait must not stop the navigation anchor between strides.
          velocity.set(vx, 0, vz);
          keyboardMoving = true;
          clip = runtime.clips[moveIndex];
          action = runtime.mixer.existingAction(clip);
        }
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
        forward.normalize();
        right.crossVectors(forward, up);
        desired.copy(forward).multiplyScalar(vertical).addScaledVector(right, horizontal).normalize().multiplyScalar(sprinting ? RUN_SPEED : WALK_SPEED);
      }
      freshArrow = false;
      const dt = Math.max(0, Math.min(delta, 0.1));
      if (keyboardMoving) {
        velocity.lerp(desired, 1 - Math.exp(-10 * dt));
        // Match native stride progression to smoothed world speed, including braking.
        action?.setEffectiveTimeScale(velocity.length() / (clip === runtime.clips[runIndex] ? RUN_SPEED : WALK_SPEED));
        if (!input && velocity.lengthSq() < 0.0004) {
          velocity.set(0, 0, 0);
          keyboardMoving = false;
          options.onRest();
        }
        if (desired.lengthSq() > 0) {
          const target = Math.atan2(desired.x, desired.z) - baseHeading;
          yaw += Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw)) * (1 - Math.exp(-12 * dt));
        }
      }
    },
    afterAnimation(delta) {
      if (disposed) return;
      const dt = Math.max(0, Math.min(delta, 0.1));
      actor.updateWorldMatrix(true, true);
      for (const mesh of runtime.meshes) mesh.skeleton.update();
      hips.getWorldPosition(hip);
      let minSoleY = Infinity;
      for (let index = 0; index < probes.length; index++) {
        const probe = probes[index];
        probe.mesh.getVertexPosition(probe.vertex, point).applyMatrix4(probe.mesh.matrixWorld);
        const start = index * 3;
        current[start] = point.x - hip.x;
        current[start + 1] = point.y;
        current[start + 2] = point.z - hip.z;
        minSoleY = Math.min(minSoleY, point.y);
      }
      const lift = Math.max(0, 0.004 - minSoleY);
      const advancing = options.canInteract() && !action?.paused && dt > 0;
      // A loop seam is not a planted-foot displacement.
      const wrapped = !!action && action.time < previousActionTime;
      sampleVelocity.set(0, 0, 0);
      let weightSum = 0;
      for (let index = 0; index < probes.length; index++) {
        const start = index * 3;
        const height = current[start + 1] + lift;
        const weight = THREE.MathUtils.clamp((0.055 - height) / 0.035, 0, 1);
        const pairWeight = Math.min(weight, previousWeights[index]);
        if (sampled && !wrapped && pairWeight > 0) {
          sampleVelocity.x += (previous[start] - current[start]) * pairWeight;
          sampleVelocity.z += (previous[start + 2] - current[start + 2]) * pairWeight;
          weightSum += pairWeight;
        }
        previousWeights[index] = weight;
      }
      previous.set(current);
      previousActionTime = action?.time ?? 0;
      navigationDelta.copy(position).negate();
      if (advancing) {
        if (keyboardMoving) {
          position.addScaledVector(velocity, dt);
          contactVelocity.set(0, 0, 0);
        } else if (clip) {
          if (weightSum > 0) {
            sampleVelocity.multiplyScalar(1 / (weightSum * dt));
            sampleVelocity.clampLength(0, 3);
            contactVelocity.lerp(sampleVelocity, 1 - Math.exp(-18 * dt));
            airborneTime = 0;
          } else {
            airborneTime += dt;
            contactVelocity.multiplyScalar(Math.exp(-dt * (airborneTime < 0.12 ? 4 : 24)));
          }
          yawQuaternion.setFromAxisAngle(up, yaw);
          offset.copy(contactVelocity).applyQuaternion(yawQuaternion);
          position.addScaledVector(offset, dt);
        }
        sampled = true;
      } else {
        velocity.set(0, 0, 0); contactVelocity.set(0, 0, 0); sampled = false;
      }
      position.x = THREE.MathUtils.clamp(position.x, -3.1, 3.1);
      position.z = THREE.MathUtils.clamp(position.z, -55, 230);
      navigationDelta.add(position);
      camera.position.add(navigationDelta);
      controls.target.add(navigationDelta);
      yawQuaternion.setFromAxisAngle(up, yaw);
      offset.copy(hip).sub(basePosition).applyQuaternion(yawQuaternion);
      actor.quaternion.copy(yawQuaternion).multiply(baseQuaternion);
      actor.position.set(position.x - offset.x, basePosition.y + lift, position.z - offset.z);
      actor.scale.copy(baseScale);
      actor.updateWorldMatrix(true, true);
    },
    setPlayback,
    finishPlayback() {
      locked = false;
      keyboardMoving = false;
      velocity.set(0, 0, 0); contactVelocity.set(0, 0, 0);
      sampled = false;
    },
    clearInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInput();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clearInput);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
    },
    getState() {
      return { position: position.toArray(), moving: velocity.lengthSq() > 0.0004 || contactVelocity.lengthSq() > 0.0004, clip: clip?.name ?? null, heldKeys: Array.from(held) };
    },
  };
}
