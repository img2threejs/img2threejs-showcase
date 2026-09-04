#!/usr/bin/env node
/**
 * Retarget a Mixamo FBX clip onto the raz 41-bone rig (world-rotation-delta method),
 * and VALIDATE by forward-kinematics: the retargeted raz clip must reproduce the Mixamo
 * uppercut signature (which hand, which window, which gates) on the SAME side.
 *
 *   node scripts/retarget-uppercut.mjs --dump   # retarget + emit clip JSON + print validation
 *   node scripts/retarget-uppercut.mjs --emit <out.json>
 *   node scripts/retarget-uppercut.mjs --update-rig
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const FBX = process.env.FBX || '/Users/nhonh/Desktop/raz/raz-2/Uppercut.fbx';
const RIG_PATH = new URL('../src/demos/raz/rigData.ts', import.meta.url).pathname;
const OUT = process.argv.includes('--emit') ? process.argv[process.argv.indexOf('--emit') + 1] : null;
const UPDATE_RIG = process.argv.includes('--update-rig');

// ------------------------------------------------------------------ load

const buf = readFileSync(FBX);
const group = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const clip = group.animations.filter((a) => a.tracks.length > 0).sort((a, b) => b.tracks.length - a.tracks.length)[0];

function readRig() {
  const text = readFileSync(RIG_PATH, 'utf8');
  const s = text.indexOf('{', text.indexOf('export const RIG'));
  const e = text.lastIndexOf('}');
  return JSON.parse(text.slice(s, e + 1));
}
const rig = readRig();
const razNameIdx = Object.fromEntries(rig.bones.map((b, i) => [b.name, i]));

// Mixamo bone name -> raz bone name (23 semantic bones)
const MAP = {
  mixamorigHips: 'Pelvis',
  mixamorigSpine: 'Waist',
  mixamorigSpine1: 'Spine01',
  mixamorigSpine2: 'Spine02',
  mixamorigNeck: 'NeckTwist01',
  mixamorigHead: 'Head',
  mixamorigLeftShoulder: 'L_Clavicle',
  mixamorigLeftArm: 'L_Upperarm',
  mixamorigLeftForeArm: 'L_Forearm',
  mixamorigLeftHand: 'L_Hand',
  mixamorigLeftUpLeg: 'L_Thigh',
  mixamorigLeftLeg: 'L_Calf',
  mixamorigLeftFoot: 'L_Foot',
  mixamorigLeftToeBase: 'L_ToeBase',
  mixamorigRightShoulder: 'R_Clavicle',
  mixamorigRightArm: 'R_Upperarm',
  mixamorigRightForeArm: 'R_Forearm',
  mixamorigRightHand: 'R_Hand',
  mixamorigRightUpLeg: 'R_Thigh',
  mixamorigRightLeg: 'R_Calf',
  mixamorigRightFoot: 'R_Foot',
  mixamorigRightToeBase: 'R_ToeBase',
};
const RAZ_UNMAPPED_ANIMATED = new Set(['NeckTwist02']); // identity, between neck and head

// ------------------------------------------------------------------ helpers

const M4 = new THREE.Matrix4();
const V3 = new THREE.Vector3();
const QT = new THREE.Quaternion();
const QT2 = new THREE.Quaternion();

function worldRest(bonesByName, name) {
  // bonesByName: {name: {object, localPos(Vector3), localQuat(Quatern)}} with parent links set up
  return {};
}

// Build a clean three.js skeleton from a "name -> {position, quaternion, parent}" table.
function buildSkel(entries) {
  const bones = {};
  for (const [name, e] of Object.entries(entries)) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.fromArray(e.position);
    b.quaternion.fromArray(e.quaternion);
    bones[name] = b;
  }
  for (const [name, e] of Object.entries(entries)) {
    if (e.parent) bones[e.parent].add(bones[name]);
  }
  for (const b of Object.values(bones)) { b.updateMatrix(); b.updateMatrixWorld(true); }
  return bones;
}

// Mixamo world rest: read directly from the loaded group (native FK is known-correct T-pose),
// BEFORE any mixer runs. Avoid rebuilding a skeleton whose parent chain is unreliable.
group.updateMatrixWorld(true);
const mixWorldRestQ = {};
const mixWorldRestP = {};
for (const name of Object.keys(MAP)) {
  const o = group.getObjectByName(name);
  if (!o) throw new Error('missing mixamo bone ' + name);
  mixWorldRestQ[name] = o.getWorldQuaternion(new THREE.Quaternion());
  mixWorldRestP[name] = o.getWorldPosition(new THREE.Vector3());
}

// raz clean skeleton (world rest)
const razEntries = {};
for (const b of rig.bones) razEntries[b.name] = { position: b.position, quaternion: b.quaternion, parent: b.parent >= 0 ? rig.bones[b.parent].name : null };
const razSkel = buildSkel(razEntries);
const razWorldRestQ = {};
const razWorldRestP = {};
for (const b of rig.bones) {
  razSkel[b.name].updateMatrixWorld(true);
  razWorldRestQ[b.name] = razSkel[b.name].getWorldQuaternion(new THREE.Quaternion());
  razWorldRestP[b.name] = razSkel[b.name].getWorldPosition(new THREE.Vector3());
}

// ------------------------------------------------------------------ R_align: pure yaw about Y, from left vectors projected to XZ
function normalize(v) { v.normalize(); return v; }
// source left = +X (T-pose arms).  target left from clavicles.
const sL2 = new THREE.Vector3(1, 0, 0); // T-pose left is +X in Mixamo
const tL2 = normalize(razWorldRestP.L_Clavicle.clone().sub(razWorldRestP.R_Clavicle)).setY(0).normalize();
const sAng = Math.atan2(-sL2.z, sL2.x); // project: XZ plane, angle about Y
const tAng = Math.atan2(-tL2.z, tL2.x);
const yawRad = tAng - sAng;
const Ralign = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawRad, 0));
console.log('R_align pure yaw (deg):', ((yawRad * 180) / Math.PI).toFixed(2));
console.log('  source left XZ:', [sL2.x.toFixed(3), sL2.z.toFixed(3)], ' target left XZ:', [tL2.x.toFixed(3), tL2.z.toFixed(3)]);

// scale (raz units per mixamo unit): head heights
const mixHeadH = mixWorldRestP.mixamorigHead.y - Math.min(mixWorldRestP.mixamorigLeftFoot.y, mixWorldRestP.mixamorigRightFoot.y);
const razHeadH = razWorldRestP.Head.y - Math.min(razWorldRestP.L_Foot.y, razWorldRestP.R_Foot.y);
const SCALE = razHeadH / mixHeadH;
console.log(`scale raz/mix = ${SCALE.toFixed(6)}`);

// ------------------------------------------------------------------ sample animated world transforms (Mixamo)
const mixer = new THREE.AnimationMixer(group);
const action = mixer.clipAction(clip);
action.play();
const SAMPLE_HZ = 60;
const N = Math.round(clip.duration * SAMPLE_HZ) + 1;
const times = Array.from({ length: N }, (_, i) => (i * clip.duration) / (N - 1));

// forward sweep (setTime alone does not evaluate tracks)
const MIX_SAMPLES = [];
mixer.setTime(0);
group.updateMatrixWorld(true);
function snapshotMix() {
  const out = {};
  for (const name of Object.keys(MAP)) {
    out[name] = { q: group.getObjectByName(name).getWorldQuaternion(new THREE.Quaternion()), p: group.getObjectByName(name).getWorldPosition(new THREE.Vector3()) };
  }
  return out;
}
MIX_SAMPLES.push(snapshotMix());
for (let i = 1; i < N; i += 1) {
  mixer.update(times[i] - times[i - 1]);
  group.updateMatrixWorld(true);
  MIX_SAMPLES.push(snapshotMix());
}
function sampleMix(ti) { return MIX_SAMPLES[ti]; }

// ------------------------------------------------------------------ retarget (world delta applied on the target rest basis)
// Dsrc[i] = Wm(t)[i] * Wm_rest[i]^-1
// Dr[i]   = R_align * Dsrc[i] * R_align^-1
// Wr(t)[i] = Dr[i] * Wr_rest[i]
// Lr(t)[i] = Wr(t)[parent]^-1 * Wr(t)[i]

const razLocalQ = {};
const razLocalP = {};
for (const rn of Object.keys(razEntries)) razLocalQ[rn] = [];
for (const rn of Object.keys(razEntries)) razLocalP[rn] = [];

// precompute target local rest (world ratios)
const LrRest = {};
for (const b of rig.bones) {
  const tp = b.parent >= 0 ? razWorldRestQ[rig.bones[b.parent].name] : null;
  LrRest[b.name] = tp ? razWorldRestQ[b.name].clone().multiply(tp.clone().invert()) : razWorldRestQ[b.name].clone();
}

const QA = new THREE.Quaternion();
const QB = new THREE.Quaternion();
const QC = new THREE.Quaternion();
const RalignInverse = Ralign.clone().invert();
const SOURCE_FOR_RAZ = Object.fromEntries(Object.entries(MAP).map(([source, target]) => [target, source]));

for (let ti = 0; ti < N; ti += 1) {
  const s = sampleMix(ti);
  // Target world orientation for every Raz bone, in parent-before-child rig order.
  //
  // Copying the source WORLD orientation directly was the distortion bug: source and target bones
  // do not share their bind axes, so the copied quaternion effectively replaced Raz's rest basis.
  // Bone lengths remained numerically unchanged while linear-blend skinning stretched the worst 1%
  // of triangle edges to 3.39x their bind length. Transfer only the source's delta FROM ITS REST,
  // express that delta in Raz's aligned world frame, then apply it on top of Raz's own rest basis.
  const Wt = {};
  for (const b of rig.bones) {
    const sourceName = SOURCE_FOR_RAZ[b.name];
    if (sourceName) {
      // Dsrc = animatedWorld * inverse(restWorld)
      const sourceDelta = QA.copy(s[sourceName].q)
        .multiply(QB.copy(mixWorldRestQ[sourceName]).invert());
      // Daligned = alignment * Dsrc * inverse(alignment)
      const alignedDelta = QC.copy(Ralign).multiply(sourceDelta).multiply(RalignInverse);
      Wt[b.name] = alignedDelta.multiply(razWorldRestQ[b.name]).clone();
    } else if (b.parent >= 0) {
      // Unmapped twist/helper bones retain their Raz local rest orientation and follow the animated
      // parent. Holding them at rest in WORLD space counter-rotated them against their own chain.
      const parentName = rig.bones[b.parent].name;
      Wt[b.name] = Wt[parentName].clone().multiply(LrRest[b.name]);
    } else {
      Wt[b.name] = razWorldRestQ[b.name].clone();
    }
  }
  // local = parentWorld^-1 * childWorld
  for (const b of rig.bones) {
    const pw = b.parent >= 0 ? Wt[rig.bones[b.parent].name] : null;
    const L = pw ? QC.copy(pw).invert().multiply(Wt[b.name]) : Wt[b.name].clone();
    razLocalQ[b.name].push([L.x, L.y, L.z, L.w]);
  }
  // hip root motion (translation)
  const mixDelta = s.mixamorigHips.p.clone().sub(mixWorldRestP.mixamorigHips);
  const aligned = mixDelta.clone();
  aligned.applyQuaternion(Ralign).multiplyScalar(SCALE);
  aligned.applyQuaternion(razWorldRestQ.Root.clone().invert());
  const hipBind = rig.bones[razNameIdx.Hip].position;
  razLocalP.Hip.push([hipBind[0] + aligned.x, hipBind[1] + aligned.y, hipBind[2] + aligned.z]);
}
// all other bones: constant bind position
for (const b of rig.bones) {
  if (b.name === 'Hip') continue;
  razLocalP[b.name] = Array.from({ length: N }, () => b.position.slice());
}

// ------------------------------------------------------------------ validation: FK the retargeted clip, run gates, compare
const RAZ_BONES = rig.bones.map((b) => {
  const bb = new THREE.Bone();
  bb.name = b.name;
  bb.position.fromArray(b.position);
  bb.quaternion.fromArray(b.quaternion);
  return bb;
});
rig.bones.forEach((b, i) => { if (b.parent >= 0) RAZ_BONES[b.parent].add(RAZ_BONES[i]); });

// sample the retargeted result through FK at M frames
const M = 200;
const RESULT = {};
for (let fi = 0; fi < M; fi += 1) {
  const t = (fi * clip.duration) / (M - 1);
  const k = Math.round(t * SAMPLE_HZ);
  const clamped = Math.min(k, N - 1);
  // set local quats/pos for the frame
  for (const b of rig.bones) {
    const q = razLocalQ[b.name][clamped];
    RAZ_BONES[razNameIdx[b.name]].quaternion.set(q[0], q[1], q[2], q[3]);
    const p = razLocalP[b.name][clamped];
    RAZ_BONES[razNameIdx[b.name]].position.set(p[0], p[1], p[2]);
  }
  for (const b of RAZ_BONES) { b.updateMatrix(); b.updateMatrixWorld(true); }
  const fr = { t };
  for (const n of ['Pelvis', 'Head', 'L_Hand', 'R_Hand', 'L_Foot', 'R_Foot', 'L_Upperarm', 'L_Forearm', 'R_Upperarm', 'R_Forearm']) {
    fr[n] = RAZ_BONES[razNameIdx[n]].getWorldPosition(new THREE.Vector3()).clone();
  }
  RESULT[fi] = fr;
}

// uppercut gates on the retargeted raz clip (same as measure-mixamo for mix, adapted to raz names)
let H = 0; for (const f of Object.values(RESULT)) H = Math.max(H, f.Head.y); H *= 1.06;
const CHIN = 0.71;
function elbowAt(f, side) {
  const a = f[`${side}_Forearm`].clone().sub(f[`${side}_Upperarm`]);
  const b = f[`${side}_Hand`].clone().sub(f[`${side}_Forearm`]);
  if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return NaN;
  return 180 - a.normalize().angleTo(b.normalize()) * 180 / Math.PI;
}
function risingRuns(key, arr) {
  const runs = []; let start = null;
  for (let i = 1; i < arr.length; i += 1) {
    const up = arr[i][key].y > arr[i - 1][key].y;
    if (up && start === null) start = i - 1;
    if (!up && start !== null) { runs.push([start, i - 1]); start = null; }
  }
  if (start !== null) runs.push([start, arr.length - 1]);
  return runs.filter(([a, b]) => b - a >= 3);
}
const frames = Object.values(RESULT);
console.log('\n=== DEBUG — hand Y elevation ranges (height-normalised) ===');
{
  const range = (key, arr) => { const ys = arr.map((f) => f[key].y / H); let mx = arr[0]; for (const f of arr) if (f[key].y > mx[key].y) mx = f; return `[${Math.min(...ys).toFixed(3)}, ${Math.max(...ys).toFixed(3)}] peak@${mx.t.toFixed(2)}s`; };
  console.log(`  RAZ  L_Hand ${range('L_Hand', frames)}   R_Hand ${range('R_Hand', frames)}   Head ${range('Head', frames)}`);
  const srcL = MIX_SAMPLES.map((s) => s.mixamorigLeftHand.p.y / mixHeadH);
  const srcR = MIX_SAMPLES.map((s) => s.mixamorigRightHand.p.y / mixHeadH);
  let si = 0; for (let i = 0; i < MIX_SAMPLES.length; i += 1) if (MIX_SAMPLES[i].mixamorigLeftHand.p.y >= MIX_SAMPLES[si].mixamorigLeftHand.p.y) si = i;
  console.log(`  SRC  L_Hand [${Math.min(...srcL).toFixed(3)}, ${Math.max(...srcL).toFixed(3)}] peak@${times[si].toFixed(2)}s   R_Hand [${Math.min(...srcR).toFixed(3)}, ${Math.max(...srcR).toFixed(3)}]`);
  // full trajectory comparison: L_Hand / R_Hand normalized Y, 13 samples
  console.log('  trajectory L_Hand.Y (norm):');
  const samples13 = Array.from({ length: 13 }, (_, i) => i / 12);
  const srcL13 = samples13.map((u) => { const k = Math.min(Math.round(u * (N - 1)), N - 1); return MIX_SAMPLES[k].mixamorigLeftHand.p.y / mixHeadH; });
  const razL13 = samples13.map((u) => { const k = Math.min(Math.round(u * (M - 1)), M - 1); return RESULT[k].L_Hand.y / H; });
  console.log(`    SRC ${srcL13.map((x) => x.toFixed(2)).join(' ')}`);
  console.log(`    RAZ ${razL13.map((x) => x.toFixed(2)).join(' ')}`);
  const srcR13 = samples13.map((u) => { const k = Math.min(Math.round(u * (N - 1)), N - 1); return MIX_SAMPLES[k].mixamorigRightHand.p.y / mixHeadH; });
  const razR13 = samples13.map((u) => { const k = Math.min(Math.round(u * (M - 1)), M - 1); return RESULT[k].R_Hand.y / H; });
  console.log('  trajectory R_Hand.Y (norm):');
  console.log(`    SRC ${srcR13.map((x) => x.toFixed(2)).join(' ')}`);
  console.log(`    RAZ ${razR13.map((x) => x.toFixed(2)).join(' ')}`);
  // chain debug: LEFT arm (shoulder/elbow/hand world, normalized y)
  console.log('  LEFT arm chain (shoulder/elbow/hand normalized y):');
  for (const u of [0, 0.25, 0.42]) {
    const kM = Math.min(Math.round(u * (N - 1)), N - 1);
    const kR = Math.min(Math.round(u * (M - 1)), M - 1);
    const ss = MIX_SAMPLES[kM].mixamorigLeftArm.p.y / mixHeadH;
    const se = MIX_SAMPLES[kM].mixamorigLeftForeArm.p.y / mixHeadH;
    const sh = MIX_SAMPLES[kM].mixamorigLeftHand.p.y / mixHeadH;
    const rs = RESULT[kR].L_Upperarm.y / H;
    const re = RESULT[kR].L_Forearm.y / H;
    const rh = RESULT[kR].L_Hand.y / H;
    console.log(`    t=${u.toFixed(2)}  SRC shoulder ${ss.toFixed(2)} elbow ${se.toFixed(2)} hand ${sh.toFixed(2)} | RAZ shoulder ${rs.toFixed(2)} elbow ${re.toFixed(2)} hand ${rh.toFixed(2)}`);
  }
}
console.log('\n=== VALIDATION — uppercut signature on RETARGETED raz clip ===');
console.log(`figure height ${H.toFixed(2)}  duration ${clip.duration.toFixed(2)}s`);
for (const side of ['L', 'R']) {
  const key = `${side}_Hand`;
  for (const [a, b] of risingRuns(key, frames)) {
    const from = frames[a]; const to = frames[b];
    const startH = from[key].y / H; const endH = to[key].y / H; const climb = endH - startH;
    if (climb < 0.08) continue;
    const elevation = Math.atan2(climb, Math.hypot(to[key].x - from[key].x, to[key].z - from[key].z)) * 180 / Math.PI;
    let elbowMax = -Infinity; for (let i = a; i <= b; i += 1) elbowMax = Math.max(elbowMax, elbowAt(frames[i], side));
    const gates = {
      'BELOW-WAIST': from[key].y < from.Pelvis.y,
      'TO-CHIN': endH >= CHIN,
      RISING: elevation >= 60,
      ELBOW: elbowMax <= 110,
      'HIP-DRIVE': (to.Pelvis.y - from.Pelvis.y) / H / ((b - a) * (clip.duration / M)) > 0,
    };
    const passed = Object.values(gates).filter(Boolean).length;
    console.log(`  ${side}  ${from.t.toFixed(2)}-${to.t.toFixed(2)}s  start ${startH.toFixed(3)}  end ${endH.toFixed(3)}  climb ${climb.toFixed(3)}  elev ${elevation.toFixed(0)}°  elbowMax ${elbowMax.toFixed(0)}°  ${passed}/5  ${Object.entries(gates).filter(([, v]) => !v).map(([g]) => g).join(',') || 'ALL'}`);
  }
}
// compare to source (mixamo) signature for the same window 0.37-0.57
console.log('\nSOURCE (Mixamo) reference: L hand 0.37-0.57s, 4/5 (ELBOW 130°), climb 0.664, elev 66°');

// ------------------------------------------------------------------ emit
if (OUT || UPDATE_RIG) {
  function b64(f32) { return Buffer.from(f32.buffer).toString('base64'); }
  const toF32 = (arr, stride) => { const out = new Float32Array(arr.length * stride); arr.forEach((v, i) => { v.forEach((c, j) => { out[i * stride + j] = c; }); }); return out; };
  const tracks = [];
  for (const b of rig.bones) {
    const idx = razNameIdx[b.name];
    const q = toF32(razLocalQ[b.name], 4);
    const p = toF32(razLocalP[b.name], 3);
    const s = toF32(Array.from({ length: N }, () => [1, 1, 1]), 3);
    tracks.push({
      bone: idx,
      times: b64(new Float32Array(times)),
      position: b64(p),
      quaternion: b64(q),
      scale: b64(s),
    });
  }
  const outClip = { name: 'preset:biped:uppercut', duration: clip.duration, tracks };
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(outClip));
    console.log(`\nemitted ${tracks.length} tracks -> ${OUT}`);
  }
  if (UPDATE_RIG) {
    const source = readFileSync(RIG_PATH, 'utf8');
    const needle = `"name":"${outClip.name}"`;
    const nameAt = source.indexOf(needle);
    if (nameAt < 0) throw new Error(`cannot find ${needle} in rigData.ts`);
    let start = nameAt;
    while (start >= 0 && source[start] !== '{') start -= 1;
    if (start < 0) throw new Error('cannot find uppercut clip object start');
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error('cannot find uppercut clip object end');
    writeFileSync(RIG_PATH, source.slice(0, start) + JSON.stringify(outClip) + source.slice(end));
    console.log(`\nupdated ${outClip.name} in ${RIG_PATH}`);
  }
  console.log(`to splice into rigData.ts: clip name 'preset:biped:uppercut', duration ${clip.duration.toFixed(4)}s`);
}
