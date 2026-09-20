#!/usr/bin/env node
/**
 * Retarget the four supplied Mixamo/Sora FBX clips onto both embedded Sora rigs.
 *
 * The FBX loader is used only by this offline converter.  The application receives the resulting
 * base64 Float32 payloads in EncodedRig and has no runtime FBX dependency.  Without --write this
 * command is analysis-only.  --write replaces exactly the four named clip objects in both
 * rigData.skin-{a,b}.ts files and asserts that bones, skin data, and the other clips are unchanged.
 *
 * Pose-aware world transfer (all quaternions are Three.js/world quaternions):
 *   A  = R_align (pure Y-up yaw, source left axis -> target left axis)
 *   D  = A * S(t) * inverse(S0) * inverse(A)
 *   arc = shortestArc(targetBindChildDirection, A * sourceBindChildDirection)
 *   C  = arc * targetBindWorldQ
 *   W  = D * C
 *
 * C is the canonical target orientation.  It intentionally may differ from the stored target bind
 * orientation: the source FBX is a T-pose while the Sora mesh is relaxed.  The stored target bones,
 * inverse bind matrices, and mesh are never edited.  Mapped target helpers/twists follow their
 * animated parent using their target local rest rotations; only Hip receives source root translation.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DIR = '/Users/nhonh/Desktop/animations/sora';
const TARGETS = [
  { id: 'skin-a', path: resolve(ROOT, 'src/demos/sora/rigData.skin-a.ts') },
  { id: 'skin-b', path: resolve(ROOT, 'src/demos/sora/rigData.skin-b.ts') },
];
const SOURCE_CLIPS = [
  { name: 'Run Backwards', file: 'Run Backwards.fbx' },
  { name: 'Running Dive Roll', file: 'Running Dive Roll.fbx' },
  { name: 'Strafe', file: 'Strafe.fbx' },
  { name: 'Turning', file: 'Turning.fbx' },
];

// Shared semantic mapping.  Hips maps to Hip; Pelvis has no source counterpart and follows Hip.
const MAP = Object.freeze({
  mixamorigHips: 'Hip',
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
});
// Explicit semantic source parent -> source child segments.  Target child lookup is by MAP, so
// Neck -> Head crosses NeckTwist02 and never depends on whichever helper happens to be first.
const SEGMENTS = [
  ['mixamorigSpine', 'mixamorigSpine1'],
  ['mixamorigSpine1', 'mixamorigSpine2'],
  ['mixamorigSpine2', 'mixamorigNeck'],
  ['mixamorigNeck', 'mixamorigHead'],
  ['mixamorigLeftShoulder', 'mixamorigLeftArm'],
  ['mixamorigLeftArm', 'mixamorigLeftForeArm'],
  ['mixamorigLeftForeArm', 'mixamorigLeftHand'],
  ['mixamorigLeftUpLeg', 'mixamorigLeftLeg'],
  ['mixamorigLeftLeg', 'mixamorigLeftFoot'],
  ['mixamorigLeftFoot', 'mixamorigLeftToeBase'],
  ['mixamorigRightShoulder', 'mixamorigRightArm'],
  ['mixamorigRightArm', 'mixamorigRightForeArm'],
  ['mixamorigRightForeArm', 'mixamorigRightHand'],
  ['mixamorigRightUpLeg', 'mixamorigRightLeg'],
  ['mixamorigRightLeg', 'mixamorigRightFoot'],
  ['mixamorigRightFoot', 'mixamorigRightToeBase'],
];
const SOURCE_FOR_TARGET = Object.fromEntries(Object.entries(MAP).map(([source, target]) => [target, source]));
const MAPPED_SOURCE_NAMES = new Set(Object.keys(MAP));
const FINGER_RE = /Hand(?:Index|Middle|Pinky|Ring|Thumb)\d+/;
const UP = new THREE.Vector3(0, 1, 0);
const EPS = 1e-8;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sourceDir = resolve(argValue('--source-dir', DEFAULT_SOURCE_DIR));
const shouldWrite = process.argv.includes('--write');

function matchingBraceEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  throw new Error(`unterminated JSON object at byte ${start}`);
}

function readRig(path) {
  const text = readFileSync(path, 'utf8');
  const exportAt = text.indexOf('export const RIG');
  if (exportAt < 0) throw new Error(`cannot find RIG export in ${path}`);
  const start = text.indexOf('{', exportAt);
  if (start < 0) throw new Error(`cannot find RIG object in ${path}`);
  const end = matchingBraceEnd(text, start);
  const rig = JSON.parse(text.slice(start, end));
  if (!Array.isArray(rig.bones) || !Array.isArray(rig.clips)) throw new Error(`invalid EncodedRig in ${path}`);
  return { path, text, rig };
}

/** Strafe contains images; motion parsing substitutes harmless in-memory textures and a URL shim. */
function parseFbx(path) {
  const data = readFileSync(path);
  const array = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const textureProto = THREE.TextureLoader.prototype;
  const originalTextureLoad = textureProto.load;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const originalWindow = globalThis.window;
  const shimWindow = hadWindow ? originalWindow : {};
  const hadUrl = Object.prototype.hasOwnProperty.call(shimWindow, 'URL');
  const originalUrl = shimWindow.URL;
  try {
    textureProto.load = function offlineTextureLoad(url, onLoad) {
      const texture = new THREE.Texture();
      texture.name = String(url ?? 'offline-fbx-texture');
      if (onLoad) onLoad(texture);
      return texture;
    };
    if (!hadWindow) globalThis.window = shimWindow;
    shimWindow.URL = shimWindow.URL ?? {};
    shimWindow.URL.createObjectURL = () => 'blob:sora-offline-texture';
    shimWindow.URL.revokeObjectURL = () => {};
    return {
      group: new FBXLoader().parse(array, ''),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  } finally {
    textureProto.load = originalTextureLoad;
    if (hadWindow) {
      if (hadUrl) shimWindow.URL = originalUrl;
      else delete shimWindow.URL;
      globalThis.window = originalWindow;
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

function chooseAnimation(group, path) {
  const clips = group.animations.filter((clip) => clip.tracks.length > 0);
  if (!clips.length) throw new Error(`no animation tracks in ${path}`);
  clips.sort((a, b) => b.tracks.length - a.tracks.length);
  const clip = clips[0];
  if (clip.tracks.length !== 31) console.warn(`warning: ${basename(path)} has ${clip.tracks.length} tracks (expected 31)`);
  return clip;
}

function makeTargetSkeleton(rig) {
  const bones = rig.bones.map((encoded) => {
    const bone = new THREE.Bone();
    bone.name = encoded.name;
    bone.position.fromArray(encoded.position);
    bone.quaternion.fromArray(encoded.quaternion);
    bone.scale.fromArray(encoded.scale);
    return bone;
  });
  let root = null;
  rig.bones.forEach((encoded, index) => {
    if (encoded.parent >= 0) bones[encoded.parent].add(bones[index]);
    else if (!root) root = bones[index];
  });
  if (!root) throw new Error('target rig has no root bone');
  root.updateMatrixWorld(true);
  const byName = Object.fromEntries(bones.map((bone) => [bone.name, bone]));
  const worldQ = {};
  const worldP = {};
  const localQ = {};
  for (const encoded of rig.bones) {
    const bone = byName[encoded.name];
    worldQ[encoded.name] = bone.getWorldQuaternion(new THREE.Quaternion()).normalize();
    worldP[encoded.name] = bone.getWorldPosition(new THREE.Vector3());
    localQ[encoded.name] = bone.quaternion.clone().normalize();
  }
  return { bones, root, byName, worldQ, worldP, localQ };
}

function sourceRest(group) {
  group.updateMatrixWorld(true);
  const q = {};
  const p = {};
  const objects = {};
  for (const sourceName of Object.keys(MAP)) {
    const object = group.getObjectByName(sourceName);
    if (!object) throw new Error(`source FBX is missing mapped bone ${sourceName}`);
    objects[sourceName] = object;
    q[sourceName] = object.getWorldQuaternion(new THREE.Quaternion()).normalize();
    p[sourceName] = object.getWorldPosition(new THREE.Vector3());
  }
  return { q, p, objects };
}

function projectedLeft(positions, leftName, rightName) {
  const result = positions[leftName].clone().sub(positions[rightName]);
  result.y = 0;
  if (result.lengthSq() < EPS) throw new Error(`cannot measure left axis from ${leftName}/${rightName}`);
  return result.normalize();
}

function yawAlignment(sourceP, targetP) {
  const sourceLeft = projectedLeft(sourceP, 'mixamorigLeftShoulder', 'mixamorigRightShoulder');
  const targetLeft = projectedLeft(targetP, 'L_Clavicle', 'R_Clavicle');
  const sourceAngle = Math.atan2(-sourceLeft.z, sourceLeft.x);
  const targetAngle = Math.atan2(-targetLeft.z, targetLeft.x);
  const yaw = targetAngle - sourceAngle;
  return {
    quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    yaw,
    sourceLeft,
    targetLeft,
  };
}

function canonicalOrientations(source, target, align) {
  const arcsByTarget = {};
  const parentSources = new Set(SEGMENTS.map(([sourceParent]) => sourceParent));
  const incoming = [];
  for (const [sourceParent, sourceChild] of SEGMENTS) {
    const targetParent = MAP[sourceParent];
    const targetChild = MAP[sourceChild];
    const sourceDirection = source.p[sourceChild].clone().sub(source.p[sourceParent]);
    const targetDirection = target.worldP[targetChild].clone().sub(target.worldP[targetParent]);
    if (sourceDirection.lengthSq() <= EPS || targetDirection.lengthSq() <= EPS) {
      throw new Error(`cannot measure explicit bind segment ${sourceParent} -> ${sourceChild}`);
    }
    sourceDirection.normalize().applyQuaternion(align.quaternion).normalize();
    targetDirection.normalize();
    const arc = new THREE.Quaternion().setFromUnitVectors(targetDirection, sourceDirection);
    const entry = {
      arc,
      arcDeg: THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(arc.w)))),
      directionKind: `${sourceParent}->${sourceChild}`,
    };
    arcsByTarget[targetParent] = entry;
    incoming.push([sourceChild, entry]);
  }
  for (const [sourceChild, entry] of incoming) {
    if (!parentSources.has(sourceChild)) arcsByTarget[MAP[sourceChild]] = { ...entry, directionKind: `terminal:${entry.directionKind}` };
  }
  // Hip is the root-motion special case: no limb arc, just source global delta on target T0.
  arcsByTarget.Hip = { arc: new THREE.Quaternion(), arcDeg: 0, directionKind: 'Hip-global' };
  for (const targetName of Object.values(MAP)) {
    if (!arcsByTarget[targetName]) throw new Error(`missing explicit canonical segment for ${targetName}`);
    arcsByTarget[targetName].canonical = arcsByTarget[targetName].arc.clone().multiply(target.worldQ[targetName]).normalize();
  }
  return arcsByTarget;
}

function measureHeightScale(source, target) {
  const sourceFootY = Math.min(source.p.mixamorigLeftFoot.y, source.p.mixamorigRightFoot.y);
  const targetFootY = Math.min(target.worldP.L_Foot.y, target.worldP.R_Foot.y);
  const sourceHeight = source.p.mixamorigHead.y - sourceFootY;
  const targetHeight = target.worldP.Head.y - targetFootY;
  if (!(sourceHeight > EPS) || !(targetHeight > EPS)) throw new Error('invalid head-to-foot height measurement');
  return {
    scale: targetHeight / sourceHeight,
    sourceHeight,
    targetHeight,
    sourceFootY,
    targetFootY,
  };
}

function collectSampleTimes(clip) {
  const values = [0, clip.duration];
  for (let i = 0; i / 60 < clip.duration; i += 1) values.push(i / 60);
  for (const track of clip.tracks) {
    for (const time of track.times) {
      if (time >= -EPS && time <= clip.duration + EPS) values.push(Math.max(0, Math.min(clip.duration, time)));
    }
  }
  values.sort((a, b) => a - b);
  const unique = [];
  for (const value of values) {
    if (!unique.length || Math.abs(value - unique[unique.length - 1]) > 1e-7) unique.push(value);
  }
  if (Math.abs(unique[unique.length - 1] - clip.duration) > 1e-7) unique.push(clip.duration);
  else unique[unique.length - 1] = clip.duration;
  return unique;
}

function sourceSamples(group, clip, times) {
  const mixer = new THREE.AnimationMixer(group);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 0);
  action.clampWhenFinished = true;
  action.reset().play();
  const sourceObjects = Object.fromEntries(Object.keys(MAP).map((name) => [name, group.getObjectByName(name)]));
  const samples = [];
  try {
    for (const time of times) {
      mixer.setTime(Math.min(clip.duration, time));
      group.updateMatrixWorld(true);
      const frame = {};
      for (const sourceName of Object.keys(MAP)) {
        frame[sourceName] = {
          q: sourceObjects[sourceName].getWorldQuaternion(new THREE.Quaternion()).normalize(),
          p: sourceObjects[sourceName].getWorldPosition(new THREE.Vector3()),
        };
      }
      samples.push(frame);
    }
  } finally {
    action.stop();
    mixer.stopAllAction();
    mixer.uncacheAction(clip, group);
    mixer.uncacheRoot(group);
  }
  return samples;
}

function quaternionArray(q, previous) {
  const normalized = q.clone().normalize();
  if (previous && normalized.dot(previous) < 0) normalized.set(-normalized.x, -normalized.y, -normalized.z, -normalized.w);
  return [normalized.x, normalized.y, normalized.z, normalized.w];
}

function b64Float32(values) {
  const flat = values.flat();
  return Buffer.from(new Float32Array(flat).buffer).toString('base64');
}

function buildClip({ sourceLabel, clip, source, target, rig, times, frames }) {
  const align = yawAlignment(source.p, target.worldP);
  const scaleInfo = measureHeightScale(source, target);
  const canonicalByTarget = canonicalOrientations(source, target, align);
  const qValues = Object.fromEntries(rig.bones.map((bone) => [bone.name, []]));
  const pValues = Object.fromEntries(rig.bones.map((bone) => [bone.name, []]));
  const sValues = Object.fromEntries(rig.bones.map((bone) => [bone.name, []]));
  const previousQ = {};
  let maxRootTrajectoryError = 0;
  let sourceHipDeltaYMin = Infinity;
  let sourceHipDeltaYMax = -Infinity;
  let sourceHipDeltaYEnd = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const sourceHipDeltaY = frame.mixamorigHips.p.y - source.p.mixamorigHips.y;
    sourceHipDeltaYMin = Math.min(sourceHipDeltaYMin, sourceHipDeltaY);
    sourceHipDeltaYMax = Math.max(sourceHipDeltaYMax, sourceHipDeltaY);
    sourceHipDeltaYEnd = sourceHipDeltaY;
    const worldTargetQ = {};
    for (const encoded of rig.bones) {
      const targetName = encoded.name;
      const sourceName = SOURCE_FOR_TARGET[targetName];
      if (sourceName) {
        const alignedAnimated = frame[sourceName].q.clone().premultiply(align.quaternion);
        const sourceDelta = alignedAnimated
          .multiply(source.q[sourceName].clone().invert())
          .multiply(align.quaternion.clone().invert())
          .normalize();
        worldTargetQ[targetName] = sourceDelta.multiply(canonicalByTarget[targetName].canonical).normalize();
      } else if (encoded.parent >= 0) {
        const parentName = rig.bones[encoded.parent].name;
        worldTargetQ[targetName] = worldTargetQ[parentName].clone().multiply(target.localQ[targetName]).normalize();
      } else {
        worldTargetQ[targetName] = target.worldQ[targetName].clone();
      }
    }
    const rootRestQ = target.worldQ.Root;
    for (const encoded of rig.bones) {
      const targetName = encoded.name;
      const parentWorld = encoded.parent >= 0 ? worldTargetQ[rig.bones[encoded.parent].name] : null;
      const local = parentWorld
        ? parentWorld.clone().invert().multiply(worldTargetQ[targetName]).normalize()
        : worldTargetQ[targetName].clone();
      qValues[targetName].push(quaternionArray(local, previousQ[targetName]));
      previousQ[targetName] = local;
      const sourceName = SOURCE_FOR_TARGET[targetName];
      if (targetName === 'Hip' && sourceName === 'mixamorigHips') {
        const sourceDelta = frame[sourceName].p.clone()
          .sub(source.p[sourceName])
          .applyQuaternion(align.quaternion)
          .multiplyScalar(scaleInfo.scale);
        const localDelta = sourceDelta.clone().applyQuaternion(rootRestQ.clone().invert());
        const bind = target.byName.Hip.position;
        pValues[targetName].push([bind.x + localDelta.x, bind.y + localDelta.y, bind.z + localDelta.z]);
        const expectedWorld = target.worldP.Hip.clone().add(sourceDelta);
        const actualWorld = target.worldP.Hip.clone().add(localDelta.clone().applyQuaternion(rootRestQ));
        maxRootTrajectoryError = Math.max(maxRootTrajectoryError, expectedWorld.distanceTo(actualWorld));
      } else {
        pValues[targetName].push(encoded.position.slice());
      }
      sValues[targetName].push(encoded.scale.slice());
    }
  }
  const ignoredChannels = clip.tracks
    .map((track) => track.name)
    .filter((name) => !MAPPED_SOURCE_NAMES.has(name.split('.')[0]));
  const ignoredFingerChannels = ignoredChannels.filter((name) => FINGER_RE.test(name.split('.')[0]));
  const tracks = rig.bones.map((bone, index) => ({
    bone: index,
    times: b64Float32(times.map((time) => [time])),
    position: b64Float32(pValues[bone.name]),
    quaternion: b64Float32(qValues[bone.name]),
    scale: b64Float32(sValues[bone.name]),
  }));
  const clipOut = { name: sourceLabel, duration: clip.duration, tracks };
  const canonicalEntries = Object.values(canonicalByTarget);
  return {
    clip: clipOut,
    summary: {
      name: sourceLabel,
      duration: clip.duration,
      sourceTracks: clip.tracks.length,
      targetTracks: tracks.length,
      samples: times.length,
      scale: scaleInfo.scale,
      sourceHeight: scaleInfo.sourceHeight,
      targetHeight: scaleInfo.targetHeight,
      sourceFootY: scaleInfo.sourceFootY,
      targetFootY: scaleInfo.targetFootY,
      yawDeg: THREE.MathUtils.radToDeg(align.yaw),
      maxCanonicalOffsetDeg: Math.max(...canonicalEntries.map((entry) => entry.arcDeg)),
      maxRootTrajectoryError,
      sourceHipDeltaYMin,
      sourceHipDeltaYMax,
      sourceHipDeltaYEnd,
      scaledHipDeltaYEnd: sourceHipDeltaYEnd * scaleInfo.scale,
      canonicalDirectionKinds: Object.fromEntries(Object.entries(canonicalByTarget).map(([name, entry]) => [name, entry.directionKind])),
      ignoredChannels,
      ignoredFingerChannels,
      endpointTime: times[times.length - 1],
    },
  };
}

function replaceNamedClip(text, name, replacement) {
  const needle = `"name":"${name.replaceAll('"', '\\"')}"`;
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`cannot find clip ${name}`);
  if (text.indexOf(needle, first + needle.length) >= 0) throw new Error(`clip ${name} appears more than once`);
  let start = first;
  while (start >= 0 && text[start] !== '{') start -= 1;
  if (start < 0) throw new Error(`cannot find object start for clip ${name}`);
  const end = matchingBraceEnd(text, start);
  const old = JSON.parse(text.slice(start, end));
  if (old.name !== name) throw new Error(`object before ${name} is not that clip`);
  return text.slice(0, start) + JSON.stringify(replacement) + text.slice(end);
}

function assertRigPreserved(before, after, replacedNames) {
  for (const key of ['bones', 'skinIndex', 'skinWeight', 'normalise', 'vertexCount']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`${key} changed while replacing clips`);
  }
  const names = new Set([...before.clips.map((clip) => clip.name), ...after.clips.map((clip) => clip.name)]);
  for (const name of names) {
    if (replacedNames.has(name)) continue;
    const old = before.clips.filter((clip) => clip.name === name);
    const next = after.clips.filter((clip) => clip.name === name);
    if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error(`unrelated clip ${name} changed`);
  }
}

function writeTarget(target, clipOutputs) {
  const before = target.rig;
  let text = target.text;
  for (const output of clipOutputs) text = replaceNamedClip(text, output.name, output);
  const exportAt = text.indexOf('export const RIG');
  const start = text.indexOf('{', exportAt);
  const end = matchingBraceEnd(text, start);
  const after = JSON.parse(text.slice(start, end));
  assertRigPreserved(before, after, new Set(clipOutputs.map((clip) => clip.name)));
  writeFileSync(target.path, text);
}

function printSummary(sourceDirValue, sourceInfos, targetSummaries) {
  console.log(JSON.stringify({
    sourceDir: sourceDirValue,
    write: shouldWrite,
    mapping: { mappedBones: Object.keys(MAP).length, targetHelpersAtRest: true },
    clips: targetSummaries,
    sourceProvenance: sourceInfos.map((source) => ({
      name: source.name,
      file: source.file,
      sha256: source.sha256,
      duration: source.duration,
      sourceTracks: source.sourceTracks,
    })),
    invariants: {
      sourceRestIsBindPose: true,
      canonicalPose: 'target bind child direction shortest-arc aligned to A*source bind child direction; canonical may differ stored target bind',
      sourceHipTrajectory: 'aligned pure-yaw delta, scaled by target(headY-minFootY)/source(headY-minFootY)',
      endpoint: 'duration key included; LoopOnce + clampWhenFinished sampling; mixers stopped/uncached before reuse',
      skinDataUntouched: shouldWrite ? 'asserted before write' : 'not written',
    },
  }, null, 2));
}

const targets = TARGETS.map((target) => ({ ...target, ...readRig(target.path) }));
const sourceLoaded = SOURCE_CLIPS.map(({ name, file }) => {
  const path = resolve(sourceDir, file);
  const { group, sha256 } = parseFbx(path);
  const clip = chooseAnimation(group, path);
  const rest = sourceRest(group);
  const times = collectSampleTimes(clip);
  const frames = sourceSamples(group, clip, times);
  return { name, file, path, group, clip, rest, times, frames, sha256, duration: clip.duration, sourceTracks: clip.tracks.length };
});
const allSummaries = [];
for (const target of targets) {
  const outputs = [];
  const targetSkeleton = makeTargetSkeleton(target.rig);
  for (const source of sourceLoaded) {
    const built = buildClip({
      sourceLabel: source.name,
      clip: source.clip,
      source: source.rest,
      target: targetSkeleton,
      rig: target.rig,
      times: source.times,
      frames: source.frames,
    });
    outputs.push(built.clip);
    allSummaries.push({ skin: target.id, sourceSha256: source.sha256, ...built.summary });
  }
  if (shouldWrite) writeTarget(target, outputs);
}
printSummary(sourceDir, sourceLoaded, allSummaries);
