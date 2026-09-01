/**
 * Sweep every embedded clip through a real AnimationMixer and measure where things HAPPEN.
 *
 *   node tools/measure-events.mjs [--json]
 *
 * Three event kinds, all defined by dynamics rather than by eye:
 *
 *   arrest   a limb travelling fast that stops. Found as the largest deceleration in a window
 *            where speed falls from above ARREST_ENTER to below a third of it. This is the frame an
 *            impact happens on — not the frame the limb was fastest, which is earlier.
 *   plant    weight arriving on the ground: a foot at its lowest, with vertical velocity crossing
 *            from falling to still.
 *   driven   the body accelerated by something that is not its own limbs — a hip spike with no limb
 *            arrest anywhere near it. This is what a blow TAKEN looks like from inside the clip.
 *
 * Everything is normalised to figure heights (H) so the table survives a change of scale.
 */
import * as THREE from 'three';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const JSON_OUT = process.argv.includes('--json');
const RATE = 240;                 // sampling rate, Hz
const ARREST_ENTER = 1.1;         // H/s a limb must exceed to be "travelling"
const ARREST_FALL = 0.34;         // fraction of entry speed it must fall below to count as stopped
const PLANT_LOW = 0.14;           // foot height, in H, below which it can be planting
const DRIVEN_ACCEL = 9.0;         // hip acceleration, in H/s^2, that needs an outside cause
const LIMBS = ['L_Hand', 'R_Hand', 'L_ToeBase', 'R_ToeBase'];
const FEET = ['L_ToeBase', 'R_ToeBase'];

const entry = await import(pathToFileURL(process.cwd() + '/node_modules/.monster-tree/measure-entry.mjs').href);
const { rig: RIG, build } = await entry.loadRig();
const rig = build();
const scene = new THREE.Scene();
scene.add(rig.group);
scene.updateMatrixWorld(true);

const H = new THREE.Box3().setFromObject(rig.group).getSize(new THREE.Vector3()).y;
const track = [...LIMBS, 'Hip', 'Head', 'Spine02'];

const round = (v, d = 3) => { const f = 10 ** d; return Math.round(v * f) / f; };

function sweep(clip) {
  const n = Math.max(4, Math.ceil(clip.duration * RATE));
  const dt = clip.duration / n;
  const pos = new Map(track.map((b) => [b, []]));
  rig.mixer.stopAllAction();
  const action = rig.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  for (let i = 0; i <= n; i += 1) {
    action.time = Math.min(i * dt, clip.duration - 1e-6);
    rig.mixer.setTime(action.time);
    scene.updateMatrixWorld(true);
    for (const b of track) {
      pos.get(b).push(new THREE.Vector3().setFromMatrixPosition(rig.bones[b].matrixWorld));
    }
  }
  action.stop();
  return { n, dt, pos };
}

/** Central-difference speed and acceleration in H units. */
function kinematics(points, dt) {
  const speed = [];
  const accel = [];
  const vel = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const span = (Math.min(points.length - 1, i + 1) - Math.max(0, i - 1)) * dt;
    const v = new THREE.Vector3().subVectors(b, a).divideScalar(span * H);
    vel.push(v);
    speed.push(v.length());
  }
  for (let i = 0; i < speed.length; i += 1) {
    const a = vel[Math.max(0, i - 1)];
    const b = vel[Math.min(vel.length - 1, i + 1)];
    const span = (Math.min(vel.length - 1, i + 1) - Math.max(0, i - 1)) * dt;
    accel.push(new THREE.Vector3().subVectors(b, a).divideScalar(span).length());
  }
  return { speed, accel, vel };
}

const table = [];
for (const clip of rig.clips) {
  const { n, dt, pos } = sweep(clip);
  const kin = new Map(track.map((b) => [b, kinematics(pos.get(b), dt)]));
  const events = [];

  // ---- arrests: a fast limb that stops
  for (const bone of LIMBS) {
    const { speed, accel } = kin.get(bone);
    let i = 1;
    while (i < n - 2) {
      if (speed[i] < ARREST_ENTER) { i += 1; continue; }
      const entrySpeed = speed[i];
      // walk forward to the first frame it has fallen below the threshold fraction
      let j = i + 1;
      while (j < n && speed[j] > entrySpeed * ARREST_FALL) {
        if (speed[j] > entrySpeed) { i = j; }   // still accelerating; move the entry with it
        j += 1;
      }
      if (j < n) {
        // the impact frame is the largest deceleration between entry and stop, not the stop itself
        let best = i;
        for (let k = i; k <= j; k += 1) if (accel[k] > accel[best]) best = k;
        events.push({
          kind: 'arrest',
          bone,
          at: round(best * dt),
          speed: round(speed[best]),
          entrySpeed: round(entrySpeed),
          decel: round(accel[best], 1),
          height: round(pos.get(bone)[best].y / H),
        });
        i = j + Math.ceil(0.12 / dt);   // one arrest per limb per 120ms
      } else break;
    }
  }

  // ---- plants: weight arriving on the ground
  for (const bone of FEET) {
    const points = pos.get(bone);
    const { vel } = kin.get(bone);
    for (let i = 2; i < n - 2; i += 1) {
      const h = points[i].y / H;
      if (h > PLANT_LOW) continue;
      if (vel[i - 1].y >= 0 || vel[i + 1].y < vel[i - 1].y) continue;   // must be arriving, not leaving
      const impactSpeed = -vel[i - 1].y;
      if (impactSpeed < 0.55) continue;
      if (events.some((e) => e.kind === 'plant' && e.bone === bone && Math.abs(e.at - i * dt) < 0.15)) continue;
      events.push({ kind: 'plant', bone, at: round(i * dt), speed: round(impactSpeed), height: round(h) });
    }
  }

  // ---- driven: the body accelerated by something outside itself
  {
    const { accel } = kin.get('Hip');
    for (let i = 2; i < n - 2; i += 1) {
      if (accel[i] < DRIVEN_ACCEL) continue;
      if (accel[i] < accel[i - 1] || accel[i] < accel[i + 1]) continue;   // local peak only
      const t = i * dt;
      const limbBusy = events.some((e) => e.kind === 'arrest' && Math.abs(e.at - t) < 0.12);
      if (limbBusy) continue;
      if (events.some((e) => e.kind === 'driven' && Math.abs(e.at - t) < 0.2)) continue;
      events.push({ kind: 'driven', bone: 'Hip', at: round(t), decel: round(accel[i], 1) });
    }
  }

  events.sort((a, b) => a.at - b.at);

  // ---- per-clip motion budget, for calibrating the continuous layers
  const handPeak = Math.max(...['L_Hand', 'R_Hand'].map((b) => Math.max(...kin.get(b).speed)));
  const bodyMean = kin.get('Spine02').speed.reduce((s, v) => s + v, 0) / (n + 1);
  table.push({
    clip: clip.name,
    duration: round(clip.duration),
    handPeak: round(handPeak),
    bodyMean: round(bodyMean),
    events,
  });
}

const out = { figureHeight: round(H), sampleRate: RATE, thresholds: { ARREST_ENTER, ARREST_FALL, PLANT_LOW, DRIVEN_ACCEL }, clips: table };
mkdirSync('tests/.build', { recursive: true });

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\nfigure height ${out.figureHeight}   sampled at ${RATE} Hz   speeds in figure-heights/second\n`);
  for (const c of table) {
    console.log(`${c.clip.replace('preset:biped:', '').padEnd(20)} ${String(c.duration).padStart(6)}s  handPeak ${String(c.handPeak).padStart(6)}  bodyMean ${String(c.bodyMean).padStart(5)}`);
    if (!c.events.length) { console.log('    (no events above threshold)'); continue; }
    for (const e of c.events) {
      const extra = e.kind === 'arrest'
        ? `${String(e.entrySpeed).padStart(5)} -> ${String(e.speed).padStart(5)} H/s   decel ${String(e.decel).padStart(6)}   at height ${e.height}`
        : e.kind === 'plant' ? `landing at ${e.speed} H/s, height ${e.height}` : `hip accel ${e.decel}`;
      console.log(`    ${String(e.at).padStart(6)}s  ${e.kind.padEnd(7)} ${e.bone.padEnd(11)} ${extra}`);
    }
  }
}
