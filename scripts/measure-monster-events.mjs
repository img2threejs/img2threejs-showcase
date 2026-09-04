#!/usr/bin/env node
/**
 * Measure the monster's strikes, footfalls and staggers off its own embedded rig.
 *
 * This is the script that produced every number in `src/demos/monster/strikeEvents.ts`. A table of
 * timings nobody can regenerate is a table nobody can trust: if the clip set changes, run this,
 * read the output, and rewrite the table from it.
 *
 *     node scripts/measure-monster-events.mjs                # every clip in the rig
 *     node scripts/measure-monster-events.mjs slash box_02   # only clips whose name contains these
 *
 * It builds the SAME skeleton and clips the browser builds — the RIG literal is parsed straight out
 * of `rigData.ts` and driven through a real AnimationMixer — so what it measures is what renders.
 *
 * WHY THE DETECTORS ARE SHAPED THIS WAY. A wind tear that fires 80 ms after the claw has already
 * swept past reads as a bug, and nothing about "scrub the timeline and write down a number"
 * survives the clip set being reordered. So:
 *
 *   strike    a local maximum in claw speed (>= 45% of that hand's p95 for the clip, and >= 0.8
 *             H/s) that collapses by >= 50% within 0.14 s, AT extension — hip-to-hand distance in
 *             the clip's top 30% for that hand. A gesture reverses near the chest; a swipe ends
 *             reaching out. Two absolute floors on top (reach, speed) stop a clip whose arms never
 *             extend from reporting its least-bent arm as an attack.
 *   kick      the same three tests on the toe rather than the hand, with the reach measured from
 *             the hip as well. Kicks are slower at the joint than claws are, so the floors differ.
 *   footfall  a threshold CROSSING of the toe height, not a local minimum: a minimum has zero
 *             derivative by definition, so "descent speed at contact" measures ~0 for every landing
 *             including a heavy stomp. The gate is per clip and per foot, set from that foot's own
 *             lift range, because one fixed gate cannot serve a run stride and a standing shuffle.
 *   stagger   the head DRIVEN and then stopped. The strike detector cannot see these: the force
 *             arrives from outside the clip, so nothing accelerates to extension.
 *
 * Speeds and distances are in figure heights per second, with H measured here (highest head
 * position across the clip set plus a crown margin) and printed at the end, so nothing depends on
 * the normalisation scale staying what it is today.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_PATH = join(HERE, '..', 'src', 'demos', 'monster', 'rigData.ts');
const SAMPLES = 400;

/** Absolute floors a candidate must clear on top of the per-clip percentile tests. */
const CLAW_MIN_REACH = 0.30;
const CLAW_MIN_SPEED = 2.2;
const KICK_MIN_SPEED = 2.0;

const filters = process.argv.slice(2);

/** The rig ships as one JSON literal inside a TypeScript module; take the literal, not the module. */
function loadRig(path) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('= {', text.indexOf('export const RIG'));
  if (start < 0) throw new Error(`no RIG literal in ${path}`);
  return JSON.parse(text.slice(start + 2).trim().replace(/;\s*$/, ''));
}

function decodeFloats(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(bytes.length / 4);
  Buffer.from(out.buffer).set(bytes);
  return out;
}

function buildRig(rig) {
  const bones = rig.bones.map((entry) => {
    const bone = new THREE.Bone();
    bone.name = entry.name;
    bone.position.fromArray(entry.position);
    bone.quaternion.fromArray(entry.quaternion);
    bone.scale.fromArray(entry.scale);
    return bone;
  });
  rig.bones.forEach((entry, index) => {
    if (entry.parent >= 0) bones[entry.parent].add(bones[index]);
  });
  // Mirrors buildRiggedModel: the mesh carries the normalisation scale, the group the offset.
  const mesh = new THREE.Object3D();
  mesh.scale.setScalar(rig.normalise.scale);
  mesh.add(bones[rig.bones.findIndex((entry) => entry.parent < 0)]);
  const world = new THREE.Object3D();
  world.position.fromArray(rig.normalise.offset);
  world.add(mesh);
  const clips = rig.clips.map((clip) => {
    const tracks = [];
    for (const track of clip.tracks) {
      const name = rig.bones[track.bone]?.name;
      if (!name) continue;
      const times = decodeFloats(track.times);
      if (track.position) tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, decodeFloats(track.position)));
      if (track.quaternion) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, decodeFloats(track.quaternion)));
      if (track.scale) tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, decodeFloats(track.scale)));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
  return { world, bones: new Map(bones.map((bone) => [bone.name, bone])), clips, mixer: new THREE.AnimationMixer(mesh) };
}

const rig = buildRig(loadRig(RIG_PATH));
const TRACKED = ['L_Hand', 'R_Hand', 'L_ToeBase', 'R_ToeBase', 'L_Foot', 'R_Foot', 'Head', 'Spine02', 'Hip', 'L_Upperarm', 'R_Upperarm'];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)];
const up = new THREE.Vector3(0, 1, 0);

/**
 * H, measured rather than assumed: sweep every clip once at a coarse rate and take the highest head
 * position, plus a 4% crown margin because the head bone sits inside the skull.
 */
function measureFigureHeight() {
  let peak = 0;
  for (const clip of rig.clips) {
    const action = rig.mixer.clipAction(clip);
    rig.mixer.stopAllAction();
    action.reset().play();
    for (let i = 0; i < 40; i += 1) {
      rig.mixer.setTime(clip.duration * (i / 40));
      rig.world.updateMatrixWorld(true);
      peak = Math.max(peak, rig.bones.get('Head').getWorldPosition(new THREE.Vector3()).y);
    }
  }
  return peak * 1.04;
}

const FIGURE_HEIGHT = measureFigureHeight();
console.log(`figure height H = ${FIGURE_HEIGHT.toFixed(3)} world units (highest head across the clip set + 4% crown)\n`);

for (const clip of rig.clips) {
  if (filters.length && !filters.some((filter) => clip.name.includes(filter))) continue;
  const action = rig.mixer.clipAction(clip);
  rig.mixer.stopAllAction();
  action.reset().setLoop(THREE.LoopRepeat, Infinity).play();

  const dt = clip.duration / SAMPLES;
  const samples = Object.fromEntries(TRACKED.map((name) => [name, []]));
  for (let i = 0; i <= SAMPLES; i += 1) {
    // Never sample at t = duration: the mixer snaps the pose there, and that jump reads as a
    // 4 H/s limb — enough to move a percentile threshold on its own.
    rig.mixer.setTime(Math.min(i * dt, clip.duration * 0.9999));
    rig.world.updateMatrixWorld(true);
    for (const name of TRACKED) samples[name].push(rig.bones.get(name).getWorldPosition(new THREE.Vector3()));
  }

  const speedOf = (track) => track.map((_, i) => (i === 0 || i === track.length - 1)
    ? 0
    : track[i + 1].distanceTo(track[i - 1]) / (2 * dt) / FIGURE_HEIGHT);

  const lines = [];

  /** One detector, two limbs: peak -> collapse -> at extension. */
  function strikes(joint, minReach, minSpeed) {
    const track = samples[joint];
    const speed = speedOf(track);
    const reach = track.map((point, i) => point.distanceTo(samples.Hip[i]) / FIGURE_HEIGHT);
    const p95 = percentile(speed, 0.95);
    const reachGate = percentile(reach, 0.70);
    const window = Math.max(2, Math.round(0.14 / dt));
    const found = [];
    for (let i = 2; i < speed.length - window - 1; i += 1) {
      const v = speed[i];
      if (v < Math.max(0.45 * p95, 0.8)) continue;
      if (v < speed[i - 1] || v < speed[i + 1]) continue;
      let lowest = v;
      for (let k = i + 1; k <= i + window; k += 1) lowest = Math.min(lowest, speed[k]);
      const decel = 1 - lowest / v;
      if (decel < 0.5 || reach[i] < reachGate) continue;
      const previous = found[found.length - 1];
      if (previous && (i - previous.index) * dt < 0.12) {
        if (v <= previous.speed) continue;
        found.pop();
      }
      // Travel over the six samples into the peak: the direction the effect is thrown along.
      const back = Math.max(0, i - 6);
      const travel = track[i].clone().sub(track[back]).normalize();
      found.push({
        index: i, time: +(i * dt).toFixed(3), speed: +v.toFixed(2), decel: +decel.toFixed(2),
        reach: +reach[i].toFixed(3), height: +(track[i].y / FIGURE_HEIGHT).toFixed(3),
        travel: [+travel.x.toFixed(2), +travel.y.toFixed(2), +travel.z.toFixed(2)],
      });
    }
    const accepted = found.filter((e) => e.reach >= minReach && e.speed >= minSpeed);
    const rejected = found.filter((e) => !(e.reach >= minReach && e.speed >= minSpeed));
    return { p95, reachGate, accepted, rejected };
  }

  const show = (list) => list
    .map((e) => `${e.time}s v${e.speed} d${e.decel} reach${e.reach} y${e.height} dir[${e.travel}]`)
    .join(' | ');

  for (const [side, joint] of [['left', 'L_Hand'], ['right', 'R_Hand']]) {
    const { p95, reachGate, accepted, rejected } = strikes(joint, CLAW_MIN_REACH, CLAW_MIN_SPEED);
    lines.push(`  claw ${side.padEnd(5)} p95 ${p95.toFixed(2)} gate ${reachGate.toFixed(3)} -> ${accepted.length ? show(accepted) : 'none'}`);
    if (rejected.length) lines.push(`        below floors (reach ${CLAW_MIN_REACH}, v ${CLAW_MIN_SPEED}): ${show(rejected)}`);
  }
  for (const [side, joint] of [['left', 'L_ToeBase'], ['right', 'R_ToeBase']]) {
    const { p95, accepted } = strikes(joint, 0.22, KICK_MIN_SPEED);
    if (accepted.length) lines.push(`  kick ${side.padEnd(5)} p95 ${p95.toFixed(2)} -> ${show(accepted)}`);
  }

  // ---- footfalls
  for (const [foot, joint] of [['left', 'L_ToeBase'], ['right', 'R_ToeBase']]) {
    const heights = samples[joint].map((point) => point.y / FIGURE_HEIGHT);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    const range = max - min;
    const contact = min + 0.30 * range;
    const lift = min + 0.65 * range;
    const found = [];
    let armed = false;
    for (let i = 1; i <= SAMPLES; i += 1) {
      if (heights[i] > lift) armed = true;
      else if (armed && heights[i] <= contact && heights[i - 1] > contact) {
        const back = Math.max(0, i - 4);
        found.push({
          time: +(i * dt).toFixed(3),
          drop: +((heights[back] - heights[i]) / ((i - back) * dt)).toFixed(2),
        });
        armed = false;
      }
    }
    lines.push(`  step ${foot.padEnd(5)} lift-range ${range.toFixed(3)} -> `
      + (found.length ? found.map((e) => `${e.time}s drop${e.drop}`).join(' | ') : 'none'));
  }

  // ---- staggers: the head driven by something outside the clip
  for (const [label, joint] of [['head', 'Head'], ['chest', 'Spine02']]) {
    const speed = speedOf(samples[joint]);
    const p95 = percentile(speed, 0.95);
    const window = Math.max(2, Math.round(0.16 / dt));
    const found = [];
    for (let i = 2; i < speed.length - window - 1; i += 1) {
      const v = speed[i];
      if (v < Math.max(0.6 * p95, 0.35)) continue;
      if (v < speed[i - 1] || v < speed[i + 1]) continue;
      let lowest = v;
      for (let k = i + 1; k <= i + window; k += 1) lowest = Math.min(lowest, speed[k]);
      if (1 - lowest / v < 0.55) continue;
      const previous = found[found.length - 1];
      if (previous && (i * dt - previous.time) < 0.25) continue;
      found.push({ time: +(i * dt).toFixed(3), speed: +v.toFixed(2), decel: +(1 - lowest / v).toFixed(2) });
    }
    lines.push(`  driven ${label.padEnd(5)} p95 ${p95.toFixed(2)} -> `
      + (found.length ? found.slice(0, 4).map((e) => `${e.time}s v${e.speed} d${e.decel}`).join(' | ') : 'none'));
  }

  // ---- root travel: which clips need locking to stay in frame
  const hip = samples.Hip;
  const drift = Math.hypot(hip[SAMPLES].x - hip[0].x, hip[SAMPLES].z - hip[0].z) / FIGURE_HEIGHT;
  const facingSum = new THREE.Vector3();
  for (let i = 0; i <= SAMPLES; i += 40) {
    const shoulder = samples.L_Upperarm[i].clone().sub(samples.R_Upperarm[i]);
    shoulder.y = 0;
    if (shoulder.lengthSq() < 1e-8) continue;
    const facing = up.clone().cross(shoulder.normalize()).normalize();
    const stance = samples.L_ToeBase[i].clone().sub(samples.L_Foot[i])
      .add(samples.R_ToeBase[i].clone().sub(samples.R_Foot[i]));
    stance.y = 0;
    if (stance.lengthSq() > 1e-8 && facing.dot(stance.normalize()) < 0) facing.negate();
    facingSum.add(facing);
  }
  const yaw = (Math.atan2(facingSum.x, facingSum.z) * 180) / Math.PI;

  console.log(`${clip.name}  ${clip.duration.toFixed(2)}s   drift ${drift.toFixed(3)} H   mean facing yaw ${yaw.toFixed(0)} deg`);
  console.log(lines.join('\n'));
  console.log('');
}
