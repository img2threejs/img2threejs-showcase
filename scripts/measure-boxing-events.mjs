#!/usr/bin/env node
/**
 * Re-measure the boxing figure's punches, footfalls and absorbed blows from the embedded rig.
 *
 * This is the script that produced every number in `src/demos/boxing-man/punchEvents.ts`. It is
 * kept in the repo because a table of timings nobody can regenerate is a table nobody can trust: if
 * the clip set changes, run this, read the output, and update the table from it.
 *
 *     node scripts/measure-boxing-events.mjs                # every clip the demo exposes
 *     node scripts/measure-boxing-events.mjs box_02 jump    # only clips whose name contains these
 *
 * It builds the SAME skeleton and clips the browser builds — the rig JSON is parsed straight out of
 * `rigData.ts` and driven through a real AnimationMixer — so what it measures is what renders.
 *
 * THE THREE DETECTORS, and why each is shaped the way it is:
 *
 *   punch     a local maximum in hand speed (>= 45% of that hand's p95 for the clip, and >= 0.8
 *             H/s) that collapses by >= 50% within 0.14 s, AT extension (hip-to-hand distance in
 *             the clip's top 30% for that hand). The extension test is what separates a punch from
 *             an arm swing: a gesture reverses near the chest, a punch stops reaching out.
 *   footfall  a threshold CROSSING of the toe height, not a local minimum. A minimum has zero
 *             derivative by definition, so "descent speed at the contact" measured ~0 for every
 *             landing including a running stride. The gate is per clip and per foot, set from that
 *             foot's own lift range, because one fixed gate cannot serve both a running stride
 *             (0.15 H of lift) and a boxer's 0.013 H stance shuffle.
 *   absorb    the head DRIVEN and then stopped: the punch detector cannot see these, because the
 *             force arrives from outside the clip and nothing accelerates to extension.
 *
 * Speeds and distances are in figure heights per second (H = 2.152 world units) so nothing here
 * depends on the normalisation scale staying what it is.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_PATH = join(HERE, '..', 'src', 'demos', 'boxing-man', 'rigData.ts');
const FIGURE_HEIGHT = 2.152;
const SAMPLES = 400;

/**
 * The two ABSOLUTE floors a detector candidate must also clear to reach the table.
 *
 * The detector's reach test is a percentile WITHIN a clip, which is what makes it work across clips
 * of different amplitude — and also what lets a clip where the hands never extend report its least
 * bent arm as a strike. In `jump` the top-30% reach is 0.226 H: the hands stay by the chest for the
 * whole hop, and all three "peaks" it reports are the arm swing of a hop. So a candidate also has
 * to reach out in absolute terms, and be moving at a speed a punch moves at.
 */
const MIN_REACH = 0.30;
const MIN_SPEED = 2.4;

/**
 * Clips whose accepted candidates are allowed into the table at all.
 *
 * `run` reports a left hand at 0.437 s, v 3.02, reach 0.325 — over both floors, and still not a
 * punch: a runner's arm stops at the top of every swing, so an impact would flare four times a
 * second while jogging. Locomotion is carried by the speed-driven glove trail instead.
 */
const PUNCH_CLIPS = ['box_01', 'box_02', 'box_03'];

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

for (const clip of rig.clips) {
  if (filters.length && !filters.some((filter) => clip.name.includes(filter))) continue;
  const action = rig.mixer.clipAction(clip);
  rig.mixer.stopAllAction();
  action.reset().setLoop(THREE.LoopRepeat, Infinity).play();

  const dt = clip.duration / SAMPLES;
  const samples = Object.fromEntries(TRACKED.map((name) => [name, []]));
  for (let i = 0; i <= SAMPLES; i += 1) {
    // Never sample at t = duration: clampWhenFinished snaps the pose there and the jump reads as a
    // 4 H/s limb, which is enough to move a percentile threshold on its own.
    rig.mixer.setTime(Math.min(i * dt, clip.duration * 0.9999));
    rig.world.updateMatrixWorld(true);
    for (const name of TRACKED) samples[name].push(rig.bones.get(name).getWorldPosition(new THREE.Vector3()));
  }

  const speedOf = (track) => track.map((_, i) => (i === 0 || i === track.length - 1)
    ? 0
    : track[i + 1].distanceTo(track[i - 1]) / (2 * dt) / FIGURE_HEIGHT);

  const lines = [];

  // ---- punches
  for (const [glove, joint] of [['left', 'L_Hand'], ['right', 'R_Hand']]) {
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
      found.push({
        index: i, time: +(i * dt).toFixed(3), speed: +v.toFixed(2), decel: +decel.toFixed(2),
        reach: +reach[i].toFixed(3), height: +(track[i].y / FIGURE_HEIGHT).toFixed(3),
      });
    }
    const show = (list) => list.map((e) => `${e.time}s v${e.speed} d${e.decel} reach${e.reach} height${e.height}`).join(' | ');
    const accepted = found.filter((e) => e.reach >= MIN_REACH && e.speed >= MIN_SPEED);
    const rejected = found.filter((e) => !(e.reach >= MIN_REACH && e.speed >= MIN_SPEED));
    lines.push(`  punch ${glove.padEnd(5)} p95 ${p95.toFixed(2)} reach-gate ${reachGate.toFixed(3)} -> `
      + (accepted.length ? show(accepted) : 'none'));
    if (rejected.length) {
      lines.push(`         rejected by the absolute floors (reach >= ${MIN_REACH}, speed >= ${MIN_SPEED}): ${show(rejected)}`);
    }
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
    lines.push(`  step  ${foot.padEnd(5)} lift-range ${range.toFixed(3)} -> `
      + (found.length ? found.map((e) => `${e.time}s drop${e.drop}`).join(' | ') : 'none')
      + '   (entries below drop 0.18 are dropped from the table)');
  }

  // ---- absorbed blows
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
    // Reported for every clip; only the reaction clips are meant to have any.
    lines.push(`  driven ${label.padEnd(5)} p95 ${p95.toFixed(2)} -> `
      + (found.length ? found.slice(0, 4).map((e) => `${e.time}s v${e.speed} d${e.decel}`).join(' | ') : 'none'));
  }

  // ---- root travel and facing, the two things that decide framing
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
  const yaw = Math.atan2(facingSum.x, facingSum.z) * 180 / Math.PI;
  lines.push(`  root drift ${drift.toFixed(3)} H per loop`
    + `${drift > 0.2 ? '  <- needs the root lock' : ''}   mean facing yaw ${yaw.toFixed(0)} deg (0 = +Z)`);

  if (!PUNCH_CLIPS.some((name) => clip.name.includes(name))) {
    lines.push('  (not a punching clip: any accepted candidate above is locomotion and stays out of'
      + ' the table — see PUNCH_CLIPS)');
  }
  console.log(`\n${clip.name}  ${clip.duration.toFixed(2)}s\n${lines.join('\n')}`);
}
