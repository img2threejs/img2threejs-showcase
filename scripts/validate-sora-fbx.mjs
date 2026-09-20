#!/usr/bin/env node
/**
 * Independent validation for the four Sora Mixamo clips.
 *
 * This intentionally does not import or call the retargeter.  Source FBXs are
 * sampled with FBXLoader, while target clips are sampled from the real Sora
 * showcase through Vite SSR.  The report is evidence-first: deformation
 * stretch values are reported without pretending there is a universal mesh
 * quality threshold, while motion/timing/bind invariants have explicit gates.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { createServer } from 'vite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DIR = '/Users/nhonh/Desktop/animations/sora';
const SAMPLE_COUNT = 25;
const MAX_VERTEX_GRID = 512;
const MAX_TRIANGLE_GRID = 1024;
const EPSILON = 1e-8;

const CLIP_SPECS = [
  { id: 'Run Backwards', file: 'Run Backwards.fbx' },
  { id: 'Running Dive Roll', file: 'Running Dive Roll.fbx' },
  { id: 'Strafe', file: 'Strafe.fbx' },
  { id: 'Turning', file: 'Turning.fbx' },
];

// This is the deliberately small transfer contract. Finger channels are
// discovered and reported separately rather than being counted as transferred.
const SOURCE_TO_TARGET = Object.freeze({
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
  mixamorigRightShoulder: 'R_Clavicle',
  mixamorigRightArm: 'R_Upperarm',
  mixamorigRightForeArm: 'R_Forearm',
  mixamorigRightHand: 'R_Hand',
  mixamorigLeftUpLeg: 'L_Thigh',
  mixamorigLeftLeg: 'L_Calf',
  mixamorigLeftFoot: 'L_Foot',
  mixamorigLeftToeBase: 'L_ToeBase',
  mixamorigRightUpLeg: 'R_Thigh',
  mixamorigRightLeg: 'R_Calf',
  mixamorigRightFoot: 'R_Foot',
  mixamorigRightToeBase: 'R_ToeBase',
});

const SEGMENTS = [
  { id: 'L_upper_arm', sourceA: 'mixamorigLeftArm', sourceB: 'mixamorigLeftForeArm', targetA: 'L_Upperarm', targetB: 'L_Forearm' },
  { id: 'L_lower_arm', sourceA: 'mixamorigLeftForeArm', sourceB: 'mixamorigLeftHand', targetA: 'L_Forearm', targetB: 'L_Hand' },
  { id: 'R_upper_arm', sourceA: 'mixamorigRightArm', sourceB: 'mixamorigRightForeArm', targetA: 'R_Upperarm', targetB: 'R_Forearm' },
  { id: 'R_lower_arm', sourceA: 'mixamorigRightForeArm', sourceB: 'mixamorigRightHand', targetA: 'R_Forearm', targetB: 'R_Hand' },
  { id: 'L_upper_leg', sourceA: 'mixamorigLeftUpLeg', sourceB: 'mixamorigLeftLeg', targetA: 'L_Thigh', targetB: 'L_Calf' },
  { id: 'L_lower_leg', sourceA: 'mixamorigLeftLeg', sourceB: 'mixamorigLeftFoot', targetA: 'L_Calf', targetB: 'L_Foot' },
  { id: 'R_upper_leg', sourceA: 'mixamorigRightUpLeg', sourceB: 'mixamorigRightLeg', targetA: 'R_Thigh', targetB: 'R_Calf' },
  { id: 'R_lower_leg', sourceA: 'mixamorigRightLeg', sourceB: 'mixamorigRightFoot', targetA: 'R_Calf', targetB: 'R_Foot' },
];
const TORSO_CHAIN = [
  { sourceA: 'mixamorigHips', sourceB: 'mixamorigSpine' },
  { sourceA: 'mixamorigSpine', sourceB: 'mixamorigSpine1' },
  { sourceA: 'mixamorigSpine1', sourceB: 'mixamorigSpine2' },
  { sourceA: 'mixamorigSpine2', sourceB: 'mixamorigNeck' },
];


const REQUIRED_SOURCE_BONES = [
  ...Object.keys(SOURCE_TO_TARGET),
];
const REQUIRED_TARGET_BONES = [...new Set(Object.values(SOURCE_TO_TARGET))];

// The existing catalog is intentionally checked by name/count. Its per-skin
// durations are allowed to differ because the two embedded rig streams came
// from different source exports; the four named clips are checked separately.
const EXISTING_CLIPS = [
  'preset:biped:climb', 'preset:biped:dive', 'preset:biped:fall', 'preset:biped:hurt',
  'preset:biped:idle', 'preset:biped:jump', 'preset:biped:run', 'preset:biped:shoot',
  'preset:biped:slash', 'preset:biped:turn', 'preset:biped:walk', 'preset:biped:run_upstairs',
  'preset:biped:scratch', 'preset:biped:sit', 'preset:biped:standing_relax', 'preset:biped:surf',
  'preset:biped:swagger', 'preset:biped:swim', 'preset:biped:wait', 'preset:biped:box_01',
  'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:defeat_02', 'preset:biped:defeat_03',
  'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:hit_to_body_01',
  'preset:biped:greet_01', 'preset:biped:greet_02', 'preset:biped:jump_rope_01',
  'preset:biped:volleyball', 'preset:biped:warm_up', 'preset:biped:dance_01', 'preset:biped:dance_02',
  'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06',
  'preset:biped:play_mobile_game', 'preset:biped:play_video_game',
];

const TOLERANCES = Object.freeze({
  durationSeconds: 1e-6,
  directionP95Degrees: 2,
  directionMaxDegrees: 5,
  torsoP95Degrees: 8,
  torsoMaxDegrees: 15,
  rootTrajectoryP95BodyHeights: 1e-4,
  rootTrajectoryMaxBodyHeights: 2e-4,
  minimumDynamicRadians: 0.02,
  minimumRootSpanBodyHeights: 0.005,
  scaleRelative: 1e-4,
  lengthRelative: 1e-4,
  localTranslation: 1e-4,
  helperQuaternionRadians: 1e-3,
  inverseBindAbsolute: 1e-7,
  switchPhase: 0.01,
  rollInversionMinUpY: -0.75,
  turningYawErrorDegrees: 35,
  rollSourceMinUpY: -0.8,
});

function parseSourceDir() {
  const equals = process.argv.find((value) => value.startsWith('--source-dir='));
  if (equals) return resolve(equals.slice('--source-dir='.length));
  const index = process.argv.indexOf('--source-dir');
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--source-dir requires a directory path');
    return resolve(value);
  }
  return DEFAULT_SOURCE_DIR;
}

function finiteVector(vector) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function finiteQuaternion(quaternion) {
  return Number.isFinite(quaternion.x) && Number.isFinite(quaternion.y)
    && Number.isFinite(quaternion.z) && Number.isFinite(quaternion.w);
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function roundVector(vector, digits = 6) {
  return [round(vector.x, digits), round(vector.y, digits), round(vector.z, digits)];
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function angleBetween(a, b) {
  if (!finiteVector(a) || !finiteVector(b) || a.lengthSq() < EPSILON || b.lengthSq() < EPSILON) return null;
  return Math.acos(clamp(a.dot(b) / Math.sqrt(a.lengthSq() * b.lengthSq()), -1, 1));
}

function directionBetween(from, to) {
  const direction = to.clone().sub(from);
  if (!finiteVector(direction) || direction.lengthSq() < EPSILON) return null;
  return direction.normalize();
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

function angleStats(radians) {
  const finite = radians.filter(Number.isFinite);
  if (!finite.length) return { count: 0, meanDegrees: null, p50Degrees: null, p95Degrees: null, maxDegrees: null };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return {
    count: finite.length,
    meanDegrees: round(THREE.MathUtils.radToDeg(mean), 3),
    p50Degrees: round(THREE.MathUtils.radToDeg(percentile(finite, 0.5)), 3),
    p95Degrees: round(THREE.MathUtils.radToDeg(percentile(finite, 0.95)), 3),
    maxDegrees: round(THREE.MathUtils.radToDeg(Math.max(...finite)), 3),
  };
}

function range3(vectors) {
  const values = vectors.filter(finiteVector);
  if (!values.length) return { min: null, max: null, span: null };
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const value of values) {
    min.min(value);
    max.max(value);
  }
  return {
    min: roundVector(min),
    max: roundVector(max),
    span: roundVector(max.clone().sub(min)),
  };
}

function normalizeTrackBoneName(trackName) {
  const dot = trackName.indexOf('.');
  return dot >= 0 ? trackName.slice(0, dot) : trackName;
}

function clipTrackEnd(clip) {
  let end = 0;
  for (const track of clip.tracks) {
    const times = track.times;
    if (times?.length) end = Math.max(end, times[times.length - 1]);
  }
  return end;
}

function makeSourceTextureShim() {
  const texturePrototype = THREE.TextureLoader.prototype;
  const previousLoad = texturePrototype.load;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const previousWarn = console.warn;
  const warnings = [];
  texturePrototype.load = function motionOnlyTexture() {
    return new THREE.Texture();
  };
  // FBXLoader's embedded-image parser references window.URL before it asks the
  // TextureLoader to load anything. This narrow shim makes that path harmless.
  globalThis.window = {
    URL: {
      createObjectURL() {
        return 'blob:sora-validator-motion-only';
      },
    },
  };
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return () => {
    texturePrototype.load = previousLoad;
    console.warn = previousWarn;
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
    return warnings;
  };
}

function readSourceClip(filePath, id) {
  if (!existsSync(filePath)) throw new Error(`missing source FBX: ${filePath}`);
  if (!statSync(filePath).isFile()) throw new Error(`source FBX is not a file: ${filePath}`);
  const bytes = readFileSync(filePath);
  const restore = makeSourceTextureShim();
  let group;
  let warnings;
  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    group = new FBXLoader().parse(arrayBuffer, `${dirname(filePath)}/`);
  } finally {
    warnings = restore();
  }
  group.updateMatrixWorld(true);
  const candidates = group.animations.filter((clip) => clip.tracks.length > 0);
  candidates.sort((a, b) => b.tracks.length - a.tracks.length || b.duration - a.duration);
  const clip = candidates[0];
  if (!clip) throw new Error(`FBX has no animation tracks: ${filePath}`);

  const bones = {};
  for (const sourceName of REQUIRED_SOURCE_BONES) {
    const object = group.getObjectByName(sourceName)
      ?? group.getObjectByName(sourceName.replace('mixamorig', 'mixamorig:'));
    if (!object) throw new Error(`${filePath}: missing required Mixamo bone ${sourceName}`);
    bones[sourceName] = object;
  }
  const restPositions = Object.fromEntries(
    Object.entries(bones).map(([name, bone]) => [name, bone.getWorldPosition(new THREE.Vector3())]),
  );
  const trackBones = [...new Set(clip.tracks.map((track) => normalizeTrackBoneName(track.name)))];
  const unsupported = trackBones.filter((name) => !SOURCE_TO_TARGET[name]).sort();
  const mappedTrackBones = trackBones.filter((name) => !!SOURCE_TO_TARGET[name]);
  const mappedObjectBones = Object.keys(SOURCE_TO_TARGET).filter((name) => !!bones[name]);
  const staticMappedBones = mappedObjectBones.filter((name) => !mappedTrackBones.includes(name));
  const mixer = new THREE.AnimationMixer(group);

  const sample = (time) => {
    const action = mixer.clipAction(clip);
    mixer.stopAllAction();
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(clamp(time, 0, clip.duration));
    group.updateMatrixWorld(true);
    const positions = Object.fromEntries(
      Object.entries(bones).map(([name, bone]) => [name, bone.getWorldPosition(new THREE.Vector3())]),
    );
    return makeKinematicFrame(positions, restPositions.mixamorigHips);
  };

  const restFrame = makeKinematicFrame(restPositions, restPositions.mixamorigHips);
  const frameTimes = Array.from({ length: SAMPLE_COUNT }, (_, index) =>
    clip.duration * index / (SAMPLE_COUNT - 1));
  const frames = frameTimes.map(sample);
  return {
    id,
    file: filePath,
    group,
    clip,
    clipDuration: clip.duration,
    trackEnd: clipTrackEnd(clip),
    trackCount: clip.tracks.length,
    trackBones,
    mappedTrackBones,
    mappedObjectBones,
    staticMappedBones,
    unsupported,
    unsupportedFingerChannels: unsupported.filter((name) => /finger|thumb|index|middle|ring|pinky/i.test(name)),
    warnings,
    restPositions,
    restFrame,
    frames,
    frameTimes,
    bodyHeight: figureHeight(restPositions),
    rootRange: range3(frames.map((frame) => frame.rootDelta)),
    hipPositionRange: range3(frames.map((frame) => frame.positions.mixamorigHips)),
  };
}

function figureHeight(positions) {
  const head = positions.mixamorigHead ?? positions.Head;
  const feet = [
    positions.mixamorigLeftFoot ?? positions.L_Foot,
    positions.mixamorigRightFoot ?? positions.R_Foot,
  ].filter(Boolean);
  if (!head || feet.length === 0) return 0;
  return head.y - Math.min(...feet.map((foot) => foot.y));
}

function makeKinematicFrame(positions, restHip) {
  const directions = {};
  for (const segment of SEGMENTS) {
    directions[segment.id] = directionBetween(positions[segment.sourceA] ?? positions[segment.targetA], positions[segment.sourceB] ?? positions[segment.targetB]);
  }
  const left = directionBetween(
    positions.mixamorigRightShoulder ?? positions.R_Clavicle,
    positions.mixamorigLeftShoulder ?? positions.L_Clavicle,
  );
  const up = directionBetween(
    positions.mixamorigHips ?? positions.Hip,
    positions.mixamorigNeck ?? positions.NeckTwist01,
  );
  const forward = left && up ? left.clone().cross(up).normalize() : null;
  directions.torso_up = up;
  directions.torso_forward = forward;
  const hip = positions.mixamorigHips ?? positions.Hip;
  const rootDelta = hip && restHip ? hip.clone().sub(restHip) : new THREE.Vector3();
  return { positions, directions, rootDelta };
}

function weightedTorsoDirections(frame, restPositions) {
  const weightedUp = new THREE.Vector3();
  for (const segment of TORSO_CHAIN) {
    const dynamicDirection = directionBetween(frame.positions[segment.sourceA], frame.positions[segment.sourceB]);
    const restA = restPositions[segment.sourceA];
    const restB = restPositions[segment.sourceB];
    const weight = restA && restB ? restA.distanceTo(restB) : 0;
    if (dynamicDirection && Number.isFinite(weight) && weight > EPSILON) weightedUp.addScaledVector(dynamicDirection, weight);
  }
  const up = weightedUp.lengthSq() >= EPSILON ? weightedUp.normalize() : null;
  const left = directionBetween(frame.positions.mixamorigRightShoulder, frame.positions.mixamorigLeftShoulder);
  const forward = left && up ? left.clone().cross(up).normalize() : null;
  return { torso_up: up, torso_forward: forward };
}


function mappedTargetPositions(bones) {
  return Object.fromEntries(Object.entries(SOURCE_TO_TARGET).map(([source, target]) => [source, bones[target].getWorldPosition(new THREE.Vector3())]));
}

function targetKinematicFrame(harness) {
  const positions = mappedTargetPositions(harness.bones);
  const frame = makeKinematicFrame(positions, harness.targetRestMapped.mixamorigHips);
  const hip = harness.bones.Hip;
  const localDelta = hip.position.clone().sub(harness.restLocalPositions.Hip);
  frame.rootDelta = localDelta.applyQuaternion(harness.restRootWorldQuaternion)
    .multiplyScalar(harness.mesh.scale.x);
  return frame;
}

function quaternionForHeading(sourceRest, targetRest) {
  const source = sourceRest.clone().setY(0);
  const target = targetRest.clone().setY(0);
  if (source.lengthSq() < EPSILON || target.lengthSq() < EPSILON) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(source.normalize(), target.normalize());
}


function signedYaw(from, to) {
  const a = from.clone().setY(0);
  const b = to.clone().setY(0);
  if (a.lengthSq() < EPSILON || b.lengthSq() < EPSILON) return null;
  a.normalize();
  b.normalize();
  return Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
}

function buildGeometryGrid(mesh) {
  const positions = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  const vertexCount = positions.count;
  const vertexGrid = [];
  const vertexSamples = Math.min(MAX_VERTEX_GRID, vertexCount);
  for (let indexInGrid = 0; indexInGrid < vertexSamples; indexInGrid += 1) {
    const value = vertexSamples <= 1 ? 0 : Math.round(indexInGrid * (vertexCount - 1) / (vertexSamples - 1));
    if (vertexGrid[vertexGrid.length - 1] !== value) vertexGrid.push(value);
  }
  const indexCount = index ? index.count : vertexCount;
  const triangleCount = Math.floor(indexCount / 3);
  const stride = Math.max(1, Math.ceil(triangleCount / MAX_TRIANGLE_GRID));
  const triangles = [];
  const triangleVertexSet = new Set();
  for (let triangle = 0; triangle < triangleCount; triangle += stride) {
    const at = triangle * 3;
    const a = index ? index.getX(at) : at;
    const b = index ? index.getX(at + 1) : at + 1;
    const c = index ? index.getX(at + 2) : at + 2;
    triangles.push({ triangle, a, b, c });
    triangleVertexSet.add(a);
    triangleVertexSet.add(b);
    triangleVertexSet.add(c);
  }
  const allVertices = [...new Set([...vertexGrid, ...triangleVertexSet])];
  return {
    vertexGrid,
    triangles,
    allVertices,
    triangleStride: stride,
    sourceTriangleCount: triangleCount,
  };
}

function readPosedVertices(harness) {
  harness.root.updateMatrixWorld(true);
  const posed = new Map();
  const position = new THREE.Vector3();
  for (const index of harness.grid.allVertices) {
    harness.mesh.getVertexPosition(index, position);
    const world = position.clone().applyMatrix4(harness.mesh.matrixWorld);
    posed.set(index, world);
  }
  return posed;
}

function captureBindGeometry(harness) {
  harness.restoreRestPose();
  harness.rig.update(0);
  harness.root.updateMatrixWorld(true);
  const positions = readPosedVertices(harness);
  const edges = new Map();
  for (const triangle of harness.grid.triangles) {
    for (const [from, to] of [[triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (!edges.has(key)) edges.set(key, positions.get(to).distanceTo(positions.get(from)));
    }
  }
  harness.bindVertexPositions = positions;
  harness.bindEdges = edges;
}

function collectSkeletonEvidence(harness, accumulator) {
  const { bones, restLocalPositions, restLocalScales, restLocalQuaternions } = harness;
  let maxLengthRelative = 0;
  let maxScaleDelta = 0;
  let maxLocalTranslation = 0;
  let maxHelperQuaternion = 0;
  let maxInverseBind = 0;
  const world = new Map();
  for (const bone of bonesArray(bones)) world.set(bone.name, bone.getWorldPosition(new THREE.Vector3()));
  for (const edge of harness.lengthEdges) {
    const current = world.get(edge.child).distanceTo(world.get(edge.parent));
    maxLengthRelative = Math.max(maxLengthRelative, Math.abs(current - edge.length) / Math.max(edge.length, EPSILON));
  }
  for (const bone of bonesArray(bones)) {
    maxScaleDelta = Math.max(maxScaleDelta, bone.scale.distanceTo(restLocalScales[bone.name]));
    if (bone.name !== 'Hip') maxLocalTranslation = Math.max(maxLocalTranslation, bone.position.distanceTo(restLocalPositions[bone.name]));
    if (harness.restOnlyBones.has(bone.name)) {
      const q = restLocalQuaternions[bone.name];
      maxHelperQuaternion = Math.max(maxHelperQuaternion, 2 * Math.acos(clamp(Math.abs(q.dot(bone.quaternion)), -1, 1)));
    }
  }
  for (let boneIndex = 0; boneIndex < harness.mesh.skeleton.boneInverses.length; boneIndex += 1) {
    const current = harness.mesh.skeleton.boneInverses[boneIndex].elements;
    const rest = harness.restInverseBinds[boneIndex];
    for (let element = 0; element < 16; element += 1) maxInverseBind = Math.max(maxInverseBind, Math.abs(current[element] - rest[element]));
  }
  const meshScaleDelta = harness.mesh.scale.distanceTo(harness.restMeshScale);
  const groupScaleDelta = harness.rig.group.scale.distanceTo(harness.restGroupScale);
  accumulator.maxLengthRelative = Math.max(accumulator.maxLengthRelative, maxLengthRelative);
  accumulator.maxScaleDelta = Math.max(accumulator.maxScaleDelta, maxScaleDelta, meshScaleDelta, groupScaleDelta);
  accumulator.maxLocalTranslation = Math.max(accumulator.maxLocalTranslation, maxLocalTranslation);
  accumulator.maxHelperQuaternion = Math.max(accumulator.maxHelperQuaternion, maxHelperQuaternion);
  accumulator.maxInverseBind = Math.max(accumulator.maxInverseBind, maxInverseBind);
}

function collectDeformation(harness, accumulator, phase) {
  const posed = readPosedVertices(harness);
  for (const index of harness.grid.allVertices) {
    const vertex = posed.get(index);
    if (!finiteVector(vertex)) {
      accumulator.nonFiniteVertices += 1;
      if (accumulator.nonFiniteExamples.length < 4) accumulator.nonFiniteExamples.push({ phase: round(phase, 4), vertex: index, value: roundVector(vertex) });
    }
  }
  for (const triangle of harness.grid.triangles) {
    const points = [posed.get(triangle.a), posed.get(triangle.b), posed.get(triangle.c)];
    if (points.some((point) => !finiteVector(point))) continue;
    for (const [from, to] of [[triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const bind = harness.bindEdges.get(key);
      if (!bind || bind < EPSILON) continue;
      const ratio = posed.get(to).distanceTo(posed.get(from)) / bind;
      if (!Number.isFinite(ratio)) continue;
      accumulator.stretchRatios.push(ratio);
      if (!accumulator.worstStretch || ratio > accumulator.worstStretch.ratio) {
        accumulator.worstStretch = { ratio, phase: round(phase, 4), triangle: triangle.triangle, edge: `${from}-${to}` };
      }
    }
  }
  collectSkeletonEvidence(harness, accumulator);
}

function createDeformationAccumulator() {
  return {
    nonFiniteVertices: 0,
    nonFiniteExamples: [],
    stretchRatios: [],
    worstStretch: null,
    maxLengthRelative: 0,
    maxScaleDelta: 0,
    maxLocalTranslation: 0,
    maxHelperQuaternion: 0,
    maxInverseBind: 0,
  };
}

function finishDeformation(harness, accumulator) {
  const ratios = accumulator.stretchRatios;
  const report = {
    sampledVertices: harness.grid.allVertices.length,
    sampledVertexGrid: harness.grid.vertexGrid.length,
    sampledTriangles: harness.grid.triangles.length,
    sourceTriangleCount: harness.grid.sourceTriangleCount,
    triangleStride: harness.grid.triangleStride,
    nonFiniteVertices: accumulator.nonFiniteVertices,
    nonFiniteExamples: accumulator.nonFiniteExamples,
    triangleStretch: {
      reportOnly: true,
      sampleCount: ratios.length,
      p50: round(percentile(ratios, 0.5), 6),
      p95: round(percentile(ratios, 0.95), 6),
      p99: round(percentile(ratios, 0.99), 6),
      max: round(ratios.length ? Math.max(...ratios) : NaN, 6),
      worst: accumulator.worstStretch ? {
        ratio: round(accumulator.worstStretch.ratio, 6),
        phase: accumulator.worstStretch.phase,
        triangle: accumulator.worstStretch.triangle,
        edge: accumulator.worstStretch.edge,
      } : null,
    },
    skeleton: {
      maxLengthRelative: round(accumulator.maxLengthRelative, 8),
      maxScaleDelta: round(accumulator.maxScaleDelta, 8),
      maxLocalTranslation: round(accumulator.maxLocalTranslation, 8),
      maxHelperQuaternionRadians: round(accumulator.maxHelperQuaternion, 8),
      maxInverseBindAbsolute: round(accumulator.maxInverseBind, 10),
      excludedLengthEdge: 'Root-Hip (Hip translation is the intentional root-motion channel)',
    },
  };
  return report;
}

function bonesArray(bones) {
  return Object.values(bones);
}

function createTargetHarness(root, skinId) {
  const node = root.children.find((child) => child.userData?.rigged);
  if (!node) throw new Error(`Sora ${skinId}: showcase has no rigged child`);
  const rig = node.userData.rigged;
  const mesh = rig.mesh;
  // The showcase starts an action before returning. Force a genuine bind pose
  // before recording rest transforms; restore it again before each clip sample.
  rig.mixer.stopAllAction();
  mesh.skeleton.pose();
  root.updateMatrixWorld(true);
  const bones = Object.fromEntries(mesh.skeleton.bones.map((bone) => [bone.name, bone]));
  for (const name of REQUIRED_TARGET_BONES) if (!bones[name]) throw new Error(`Sora ${skinId}: missing target bone ${name}`);
  const rootBone = bones.Root;
  const restWorldPositions = Object.fromEntries(
    mesh.skeleton.bones.map((bone) => [bone.name, bone.getWorldPosition(new THREE.Vector3())]),
  );
  const targetRestMapped = mappedTargetPositions(bones);
  const restLocalPositions = Object.fromEntries(mesh.skeleton.bones.map((bone) => [bone.name, bone.position.clone()]));
  const restLocalScales = Object.fromEntries(mesh.skeleton.bones.map((bone) => [bone.name, bone.scale.clone()]));
  const restLocalQuaternions = Object.fromEntries(mesh.skeleton.bones.map((bone) => [bone.name, bone.quaternion.clone()]));
  const restRootWorldQuaternion = rootBone.getWorldQuaternion(new THREE.Quaternion());
  const restMeshScale = mesh.scale.clone();
  const restGroupScale = rig.group.scale.clone();
  const restGroupPosition = rig.group.position.clone();
  const restInverseBinds = mesh.skeleton.boneInverses.map((matrix) => matrix.elements.slice());
  const lengthEdges = [];
  for (const bone of mesh.skeleton.bones) {
    for (const child of bone.children) {
      if (!child.isBone || child.name === 'Hip') continue;
      const length = restWorldPositions[bone.name].distanceTo(restWorldPositions[child.name]);
      if (length > EPSILON) lengthEdges.push({ parent: bone.name, child: child.name, length });
    }
  }
  const mappedTargetNames = new Set(REQUIRED_TARGET_BONES);
  const restOnlyBones = new Set(mesh.skeleton.bones
    .map((bone) => bone.name)
    .filter((name) => !mappedTargetNames.has(name)));
  const harness = {
    skinId,
    root,
    node,
    rig,
    mesh,
    bones,
    targetRestMapped,
    restLocalPositions,
    restLocalScales,
    restLocalQuaternions,
    restRootWorldQuaternion,
    restMeshScale,
    restGroupScale,
    restGroupPosition,
    restInverseBinds,
    lengthEdges,
    restOnlyBones,
    targetBodyHeight: figureHeight(targetRestMapped),
    grid: buildGeometryGrid(mesh),
    bindVertexPositions: null,
    bindEdges: null,
    restoreRestPose() {
      for (const bone of mesh.skeleton.bones) {
        bone.position.copy(restLocalPositions[bone.name]);
        bone.quaternion.copy(restLocalQuaternions[bone.name]);
        bone.scale.copy(restLocalScales[bone.name]);
      }
      mesh.scale.copy(restMeshScale);
      rig.group.scale.copy(restGroupScale);
      rig.group.position.copy(restGroupPosition);
    },
  };
  harness.restoreRestPose();
  rig.mixer.stopAllAction();
  rig.update(0);
  root.updateMatrixWorld(true);
  harness.targetRestMapped = mappedTargetPositions(bones);
  harness.targetRestFrame = makeKinematicFrame(harness.targetRestMapped, harness.targetRestMapped.mixamorigHips);
  harness.targetBodyHeight = figureHeight(harness.targetRestMapped);
  captureBindGeometry(harness);
  return harness;
}

function sampleTargetClip(harness, clip, time) {
  harness.restoreRestPose();
  harness.rig.mixer.stopAllAction();
  const action = harness.rig.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  harness.rig.mixer.setTime(clamp(time, 0, clip.duration));
  harness.rig.update(0); // includes showcase root compensation and, for skin B, volume update
  harness.root.updateMatrixWorld(true);
  const frame = targetKinematicFrame(harness);
  return { frame, action };
}

function clipCatalogEvidence(rig) {
  const names = new Set(rig.clips.map((clip) => clip.name));
  return {
    clipCount: rig.clips.length,
    expectedClipCount: EXISTING_CLIPS.length + CLIP_SPECS.length,
    missingExistingClips: EXISTING_CLIPS.filter((name) => !names.has(name)),
    namedClipPresence: Object.fromEntries(CLIP_SPECS.map(({ id }) => [id, names.has(id)])),
  };
}

function compareSourceTarget(source, harness, targetClip, heading, scale, failures) {
  const directionErrors = Object.fromEntries([...SEGMENTS.map((segment) => [segment.id, []]), ['torso_up', []], ['torso_forward', []]]);
  const rawDirectionErrors = { torso_up: [], torso_forward: [] };
  const sourceMotion = Object.fromEntries(Object.keys(directionErrors).map((key) => [key, 0]));
  const targetMotion = Object.fromEntries(Object.keys(directionErrors).map((key) => [key, 0]));
  const rootErrors = [];
  const targetFrames = [];
  const sourceTorsoFrames = source.frames.map((frame) => weightedTorsoDirections(frame, harness.targetRestMapped));
  const targetTorsoFrames = [];
  const deformation = createDeformationAccumulator();

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const phase = index / (SAMPLE_COUNT - 1);
    const sourceFrame = source.frames[index];
    const sourceTorso = sourceTorsoFrames[index];
    const targetTime = targetClip.duration * phase;
    const { frame: targetFrame } = sampleTargetClip(harness, targetClip, targetTime);
    const targetTorso = weightedTorsoDirections(targetFrame, harness.targetRestMapped);
    targetFrames.push(targetFrame);
    targetTorsoFrames.push(targetTorso);
    collectDeformation(harness, deformation, phase);
    for (const segment of SEGMENTS) {
      const sourceDirection = sourceFrame.directions[segment.id];
      const targetDirection = targetFrame.directions[segment.id];
      const expected = sourceDirection?.clone().applyQuaternion(heading).normalize() ?? null;
      const error = expected && targetDirection ? angleBetween(expected, targetDirection) : null;
      if (error === null) failures.push({ clip: source.id, skin: harness.skinId, kind: 'direction-sample', segment: segment.id, phase: round(phase, 4) });
      else directionErrors[segment.id].push(error);
    }
    for (const key of ['torso_up', 'torso_forward']) {
      const sourceDirection = sourceTorso[key];
      const targetDirection = targetTorso[key];
      const expected = sourceDirection?.clone().applyQuaternion(heading).normalize() ?? null;
      const error = expected && targetDirection ? angleBetween(expected, targetDirection) : null;
      if (error === null) failures.push({ clip: source.id, skin: harness.skinId, kind: 'direction-sample', segment: key, phase: round(phase, 4) });
      else directionErrors[key].push(error);
      const rawSourceDirection = sourceFrame.directions[key];
      const rawTargetDirection = targetFrame.directions[key];
      const rawExpected = rawSourceDirection?.clone().applyQuaternion(heading).normalize() ?? null;
      const rawError = rawExpected && rawTargetDirection ? angleBetween(rawExpected, rawTargetDirection) : null;
      if (rawError !== null) rawDirectionErrors[key].push(rawError);
    }
    const expectedRoot = sourceFrame.rootDelta.clone().applyQuaternion(heading).multiplyScalar(scale);
    const rootError = targetFrame.rootDelta.distanceTo(expectedRoot) / Math.max(harness.targetBodyHeight, EPSILON);
    if (Number.isFinite(rootError)) rootErrors.push(rootError);
    else failures.push({ clip: source.id, skin: harness.skinId, kind: 'root-sample', phase: round(phase, 4) });
  }
  const sourceFrameZero = source.frames[0];
  const targetFrameZero = targetFrames[0];
  for (const key of Object.keys(directionErrors)) {
    for (let index = 0; index < source.frames.length; index += 1) {
      const sourceDirections = key.startsWith('torso_') ? sourceTorsoFrames[index] : source.frames[index].directions;
      const sourceOriginDirections = key.startsWith('torso_') ? sourceTorsoFrames[0] : sourceFrameZero.directions;
      if (sourceDirections[key] && sourceOriginDirections[key]) sourceMotion[key] = Math.max(sourceMotion[key], angleBetween(sourceOriginDirections[key], sourceDirections[key]) ?? 0);
    }
    for (let index = 0; index < targetFrames.length; index += 1) {
      const targetDirections = key.startsWith('torso_') ? targetTorsoFrames[index] : targetFrames[index].directions;
      const targetOriginDirections = key.startsWith('torso_') ? targetTorsoFrames[0] : targetFrameZero.directions;
      if (targetDirections[key] && targetOriginDirections[key]) targetMotion[key] = Math.max(targetMotion[key], angleBetween(targetOriginDirections[key], targetDirections[key]) ?? 0);
    }
  }

  const directionReport = {};
  for (const [key, values] of Object.entries(directionErrors)) {
    const stats = angleStats(values);
    directionReport[key] = stats;
    const torso = key.startsWith('torso_');
    const p95Limit = torso ? TOLERANCES.torsoP95Degrees : TOLERANCES.directionP95Degrees;
    const maxLimit = torso ? TOLERANCES.torsoMaxDegrees : TOLERANCES.directionMaxDegrees;
    if (stats.p95Degrees === null || stats.p95Degrees > p95Limit || stats.maxDegrees > maxLimit) {
      failures.push({ clip: source.id, skin: harness.skinId, kind: 'direction-error', segment: key, p95Degrees: stats.p95Degrees, maxDegrees: stats.maxDegrees, p95Limit, maxLimit });
    }
  }
  const limbDirectionReport = Object.fromEntries(SEGMENTS.map((segment) => [segment.id, directionReport[segment.id]]));
  const rawTorsoDirectionReport = Object.fromEntries(Object.entries(rawDirectionErrors).map(([key, values]) => [key, angleStats(values)]));
  const torsoDirectionReport = {
    torso_up: directionReport.torso_up,
    torso_forward: directionReport.torso_forward,
    rawAngularMismatch: rawTorsoDirectionReport,
    comparison: 'source world torso chain directions weighted by target bind segment lengths, then normalized; raw hip-to-neck mismatch is diagnostic only',
  };
  const worstLimb = SEGMENTS
    .map((segment) => ({ segment: segment.id, ...directionReport[segment.id] }))
    .sort((a, b) => (b.maxDegrees ?? -Infinity) - (a.maxDegrees ?? -Infinity))[0] ?? null;
  const rootStats = {
    count: rootErrors.length,
    meanBodyHeights: round(rootErrors.reduce((sum, value) => sum + value, 0) / Math.max(rootErrors.length, 1), 6),
    p95BodyHeights: round(percentile(rootErrors, 0.95), 6),
    maxBodyHeights: round(rootErrors.length ? Math.max(...rootErrors) : NaN, 6),
  };
  if (rootStats.p95BodyHeights === null || rootStats.p95BodyHeights > TOLERANCES.rootTrajectoryP95BodyHeights || rootStats.maxBodyHeights > TOLERANCES.rootTrajectoryMaxBodyHeights) {
    failures.push({ clip: source.id, skin: harness.skinId, kind: 'root-trajectory-error', ...rootStats });
  }

  const sourceDynamic = Math.max(...Object.values(sourceMotion));
  const targetDynamic = Math.max(...Object.values(targetMotion));
  const sourceRootOrigin = sourceFrameZero.rootDelta;
  const targetRootOrigin = targetFrameZero.rootDelta;
  const sourceRootSpan = Math.max(...source.frames.map((frame) => frame.rootDelta.clone().sub(sourceRootOrigin).length())) / Math.max(source.bodyHeight, EPSILON);
  const targetRootSpan = Math.max(...targetFrames.map((frame) => frame.rootDelta.clone().sub(targetRootOrigin).length())) / Math.max(harness.targetBodyHeight, EPSILON);
  const dynamicReport = {
    sourceMaxDirectionRadians: round(sourceDynamic, 6),
    targetMaxDirectionRadians: round(targetDynamic, 6),
    sourceRootSpanBodyHeights: round(sourceRootSpan, 6),
    targetRootSpanBodyHeights: round(targetRootSpan, 6),
    targetDynamicallyVaries: targetDynamic >= TOLERANCES.minimumDynamicRadians || targetRootSpan >= TOLERANCES.minimumRootSpanBodyHeights,
  };
  if (!dynamicReport.targetDynamicallyVaries) failures.push({ clip: source.id, skin: harness.skinId, kind: 'static-target-clip', dynamicReport });

  const skeleton = finishDeformation(harness, deformation);
  if (deformation.nonFiniteVertices > 0) failures.push({ clip: source.id, skin: harness.skinId, kind: 'non-finite-deformation', count: deformation.nonFiniteVertices, examples: deformation.nonFiniteExamples });
  if (deformation.maxLengthRelative > TOLERANCES.lengthRelative) failures.push({ clip: source.id, skin: harness.skinId, kind: 'skeleton-length-drift', value: deformation.maxLengthRelative, tolerance: TOLERANCES.lengthRelative });
  if (deformation.maxScaleDelta > TOLERANCES.scaleRelative) failures.push({ clip: source.id, skin: harness.skinId, kind: 'skeleton-scale-drift', value: deformation.maxScaleDelta, tolerance: TOLERANCES.scaleRelative });
  if (deformation.maxLocalTranslation > TOLERANCES.localTranslation) failures.push({ clip: source.id, skin: harness.skinId, kind: 'rest-translation-drift', value: deformation.maxLocalTranslation, tolerance: TOLERANCES.localTranslation });
  if (deformation.maxHelperQuaternion > TOLERANCES.helperQuaternionRadians) failures.push({ clip: source.id, skin: harness.skinId, kind: 'helper-rest-rotation-drift', value: deformation.maxHelperQuaternion, tolerance: TOLERANCES.helperQuaternionRadians });
  if (deformation.maxInverseBind > TOLERANCES.inverseBindAbsolute) failures.push({ clip: source.id, skin: harness.skinId, kind: 'inverse-bind-drift', value: deformation.maxInverseBind, tolerance: TOLERANCES.inverseBindAbsolute });

  const sourceMinUpY = Math.min(...source.frames.map((frame) => frame.directions.torso_up?.y ?? Infinity));
  const targetMinUpY = Math.min(...targetFrames.map((frame) => frame.directions.torso_up?.y ?? Infinity));
  const special = { sourceMinTorsoUpY: round(sourceMinUpY, 6), targetMinTorsoUpY: round(targetMinUpY, 6) };
  if (source.id === 'Running Dive Roll') {
    special.rollInversionRequired = sourceMinUpY <= TOLERANCES.rollSourceMinUpY;
    special.rollInversionObserved = targetMinUpY <= TOLERANCES.rollInversionMinUpY;
    if (special.rollInversionRequired && !special.rollInversionObserved) failures.push({ clip: source.id, skin: harness.skinId, kind: 'roll-inversion-missing', sourceMinTorsoUpY: round(sourceMinUpY, 6), targetMinTorsoUpY: round(targetMinUpY, 6), required: TOLERANCES.rollInversionMinUpY });
  }
  if (source.id === 'Turning') {
    const sourceStartForward = source.frames[0].directions.torso_forward.clone().applyQuaternion(heading);
    const sourceEndForward = source.frames.at(-1).directions.torso_forward.clone().applyQuaternion(heading);
    const targetStartForward = targetFrames[0].directions.torso_forward;
    const targetEndForward = targetFrames.at(-1).directions.torso_forward;
    const sourceYaw = signedYaw(sourceStartForward, sourceEndForward);
    const targetYaw = signedYaw(targetStartForward, targetEndForward);
    special.sourceTorsoYawDegrees = round(THREE.MathUtils.radToDeg(sourceYaw), 3);
    special.targetTorsoYawDegrees = round(THREE.MathUtils.radToDeg(targetYaw), 3);
    const yawDelta = sourceYaw - targetYaw;
    special.torsoYawErrorDegrees = round(THREE.MathUtils.radToDeg(Math.abs(Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta)))), 3);
    if (special.torsoYawErrorDegrees > TOLERANCES.turningYawErrorDegrees) failures.push({ clip: source.id, skin: harness.skinId, kind: 'turning-rotation-error', errorDegrees: special.torsoYawErrorDegrees, tolerance: TOLERANCES.turningYawErrorDegrees });
  }

  const timing = {
    sourceDuration: round(source.clipDuration, 9),
    targetDuration: round(targetClip.duration, 9),
    durationErrorSeconds: round(Math.abs(source.clipDuration - targetClip.duration), 9),
    sourceTrackEnd: round(source.trackEnd, 9),
    targetTrackEnd: round(clipTrackEnd(targetClip), 9),
    sourceEndpointSampled: true,
    targetEndpointSampled: true,
  };
  if (timing.durationErrorSeconds > TOLERANCES.durationSeconds) failures.push({ clip: source.id, skin: harness.skinId, kind: 'duration-mismatch', ...timing, tolerance: TOLERANCES.durationSeconds });

  return {
    clip: source.id,
    skin: harness.skinId,
    sourceFile: source.file,
    sourceTrackCount: source.trackCount,
    targetTrackCount: targetClip.tracks.length,
    mappedSourceBoneCount: source.mappedObjectBones.length,
    animatedMappedSourceBoneCount: source.mappedTrackBones.length,
    staticMappedSourceBones: source.staticMappedBones,
    transferredSourceBoneCount: source.mappedTrackBones.length,
    unsupportedSourceChannelCount: source.unsupported.length,
    unsupportedSourceChannels: source.unsupported.slice(0, 12),
    timing,
    headingAlignment: {
      sourceBindLeft: roundVector(source.restPositions.mixamorigLeftShoulder.clone().sub(source.restPositions.mixamorigRightShoulder).setY(0).normalize()),
      targetBindLeft: roundVector(harness.targetRestMapped.mixamorigLeftShoulder.clone().sub(harness.targetRestMapped.mixamorigRightShoulder).setY(0).normalize()),
      quaternion: [round(heading.x, 7), round(heading.y, 7), round(heading.z, 7), round(heading.w, 7)],
      scaleFromFigureHeight: round(scale, 8),
    },
    directionErrors: { limbs: limbDirectionReport, torso: torsoDirectionReport, worstLimb },
    rootTrajectory: {
      ...rootStats,
      sourceRangeUnits: source.rootRange,
      sourceHipPositionRangeUnits: source.hipPositionRange,
      targetRangeUnits: range3(targetFrames.map((frame) => frame.rootDelta)),
    },
    dynamic: dynamicReport,
    special,
    deformation: skeleton,
    preserveSkinVolumeOverride: Object.prototype.hasOwnProperty.call(harness.mesh, 'applyBoneTransform'),
    elbowRepairAttributes: {
      blend: !!harness.mesh.geometry.getAttribute('soraElbowBlend'),
      normal: !!harness.mesh.geometry.getAttribute('soraElbowNormal'),
    },
    catalog: clipCatalogEvidence(harness.rig),
  };
}

function findRiggedChildren(root) {
  return root.children.filter((child) => child.userData?.rigged).map((child) => ({ node: child, rig: child.userData.rigged }));
}

function finiteRigVertices(rig) {
  const mesh = rig.mesh;
  const positions = mesh.geometry.getAttribute('position');
  const grid = [];
  const count = Math.min(MAX_VERTEX_GRID, positions.count);
  for (let i = 0; i < count; i += 1) grid.push(count <= 1 ? 0 : Math.round(i * (positions.count - 1) / (count - 1)));
  mesh.updateWorldMatrix(true, true);
  const value = new THREE.Vector3();
  let nonFinite = 0;
  for (const index of [...new Set(grid)]) {
    mesh.getVertexPosition(index, value);
    value.applyMatrix4(mesh.matrixWorld);
    if (!finiteVector(value)) nonFinite += 1;
  }
  return { sampledVertices: new Set(grid).size, nonFinite };
}

async function validateStateSwitch(createSoraShowcase, failures) {
  const root = createSoraShowcase({ initialSkin: 'default' });
  const before = findRiggedChildren(root)[0];
  if (!before) {
    failures.push({ kind: 'skin-switch-no-initial-rig' });
    return { clip: 'Turning', switched: false, completed: false };
  }
  const controller = root.userData.sculptRuntime.animationController;
  controller.play('Turning');
  root.userData.tick(0.37);
  const sourceClip = before.rig.clips.find((clip) => clip.name === 'Turning');
  if (!sourceClip) {
    failures.push({ kind: 'skin-switch-missing-clip', clip: 'Turning' });
    return { clip: 'Turning', switched: false, completed: false };
  }
  const sourceAction = before.rig.mixer.clipAction(sourceClip);
  const beforePhase = sourceAction.time / sourceClip.duration;
  const switched = controller.sora.switchSkin();
  const switchingAfterSet = controller.sora.state.switching;
  const during = findRiggedChildren(root);
  const incoming = during.find((entry) => entry.node !== before.node);
  const targetClip = incoming?.rig.clips.find((clip) => clip.name === 'Turning');
  const targetAction = targetClip ? incoming.rig.mixer.clipAction(targetClip) : null;
  const afterPhase = targetAction ? targetAction.time / targetClip.duration : NaN;
  const phaseError = Math.abs(beforePhase - afterPhase);
  const duringFinite = during.map((entry) => ({ skinCandidate: entry.node === before.node ? 'outgoing' : 'incoming', ...finiteRigVertices(entry.rig) }));
  if (!switched || !incoming || !targetAction) failures.push({ kind: 'skin-switch-not-started', switched, hasIncoming: !!incoming });
  if (Number.isFinite(phaseError) && phaseError > TOLERANCES.switchPhase) failures.push({ kind: 'skin-switch-phase', beforePhase: round(beforePhase, 6), afterPhase: round(afterPhase, 6), phaseError: round(phaseError, 6), tolerance: TOLERANCES.switchPhase });
  if (duringFinite.some((entry) => entry.nonFinite > 0)) failures.push({ kind: 'skin-switch-non-finite', duringFinite });
  for (let step = 0; step < 23; step += 1) root.userData.tick(0.1);
  const after = findRiggedChildren(root);
  const finalFinite = after.map((entry) => ({ ...finiteRigVertices(entry.rig) }));
  if (controller.sora.state.switching || controller.sora.state.skinId !== 'kingdom-key' || after.length !== 1) failures.push({ kind: 'skin-switch-not-complete', state: controller.sora.state, rigCount: after.length });
  if (finalFinite.some((entry) => entry.nonFinite > 0)) failures.push({ kind: 'skin-switch-final-non-finite', finalFinite });
  return {
    clip: 'Turning',
    switched,
    beforeSkin: 'default',
    afterSkin: controller.sora.state.skinId,
    switchingAfterSet,
    beforePhase: round(beforePhase, 6),
    afterPhase: round(afterPhase, 6),
    phaseError: round(phaseError, 6),
    duringFinite,
    finalFinite,
    completed: !controller.sora.state.switching && after.length === 1,
  };
}

async function main() {
  const sourceDir = parseSourceDir();
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`source directory does not exist: ${sourceDir}`);
  const sourceByClip = new Map();
  for (const spec of CLIP_SPECS) sourceByClip.set(spec.id, readSourceClip(join(sourceDir, spec.file), spec.id));
  const server = await createServer({ root: REPO_ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

  try {
    const { createSoraShowcase } = await server.ssrLoadModule('/src/demos/sora/soraShowcase.ts');
    const combinations = [];
    const failures = [];
    for (const source of sourceByClip.values()) {
      const missingMappedObjects = Object.keys(SOURCE_TO_TARGET).filter((name) => !source.mappedObjectBones.includes(name));
      if (missingMappedObjects.length) {
        failures.push({ clip: source.id, kind: 'missing-mapped-source-bones', expected: Object.keys(SOURCE_TO_TARGET).length, actual: source.mappedObjectBones.length, missing: missingMappedObjects });
      }
    }
    for (const skinId of ['default', 'kingdom-key']) {
      const root = createSoraShowcase({ initialSkin: skinId });
      const harness = createTargetHarness(root, skinId);
      const sourceReference = sourceByClip.values().next().value;
      const sourceLeft = sourceReference.restPositions.mixamorigLeftShoulder.clone()
        .sub(sourceReference.restPositions.mixamorigRightShoulder);
      const targetLeft = harness.targetRestMapped.mixamorigLeftShoulder.clone()
        .sub(harness.targetRestMapped.mixamorigRightShoulder);
      const heading = quaternionForHeading(sourceLeft, targetLeft);
      const scale = harness.targetBodyHeight / Math.max(sourceReference.bodyHeight, EPSILON);
      const catalog = clipCatalogEvidence(harness.rig);
      if (catalog.clipCount !== catalog.expectedClipCount || catalog.missingExistingClips.length) failures.push({ kind: 'clip-catalog', skin: skinId, catalog });
      if (skinId === 'kingdom-key' && (!harness.mesh.geometry.getAttribute('soraElbowBlend') || !harness.mesh.geometry.getAttribute('soraElbowNormal'))) failures.push({ kind: 'elbow-repair-missing', skin: skinId });
      for (const spec of CLIP_SPECS) {
        const source = sourceByClip.get(spec.id);
        const targetClip = harness.rig.clips.find((clip) => clip.name === spec.id);
        if (!targetClip) {
          failures.push({ kind: 'missing-target-clip', skin: skinId, clip: spec.id });
          continue;
        }
        combinations.push(compareSourceTarget(source, harness, targetClip, heading, scale, failures));
      }
    }
    const stateSwitch = await validateStateSwitch(createSoraShowcase, failures);
    const sourceEvidence = CLIP_SPECS.map((spec) => {
      const source = sourceByClip.get(spec.id);
      return {
        clip: spec.id,
        file: source.file,
        duration: round(source.clipDuration, 9),
        trackEnd: round(source.trackEnd, 9),
        trackCount: source.trackCount,
        animatedBoneCount: source.trackBones.length,
        mappedSourceBoneCount: source.mappedObjectBones.length,
        animatedMappedSourceBoneCount: source.mappedTrackBones.length,
        staticMappedSourceBones: source.staticMappedBones,
        unsupportedSourceChannels: source.unsupported,
        unsupportedFingerChannels: source.unsupportedFingerChannels,
        unsupportedChannelsAreNotTransferred: true,
        bodyHeightUnits: round(source.bodyHeight, 6),
        rootRangeUnits: source.rootRange,
        hipPositionRangeUnits: source.hipPositionRange,
        loaderWarnings: source.warnings.slice(0, 4),
      };
    });
    const report = {
      status: failures.length ? 'DONE_WITH_CONCERNS' : 'DONE',
      sourceDir,
      sampleCount: SAMPLE_COUNT,
      sampledPhasesIncludeEndpoints: true,
      skins: ['default', 'kingdom-key'],
      combinationsExpected: 8,
      combinationsObserved: combinations.length,
      tolerances: TOLERANCES,
      sampling: {
        directionComparison: 'direct normalized world limb directions after pure bind left/right XZ heading alignment; torso uses source world chain directions weighted by target bind segment lengths and normalized; raw torso angular mismatch is retained as diagnostic',
        rootComparison: 'Hip local displacement transformed by target Root rest orientation and mesh scale; source displacement scaled by head-minus-min-foot figure-height ratio; showcase horizontal framing compensation is not judged',
        deformation: 'actual showcase mesh.getVertexPosition; Kingdom Key uses preserveSkinVolume applyBoneTransform override',
        triangleStretch: 'fixed deterministic vertex/triangle grid; p50/p95/p99/max are report-only evidence, not pass/fail thresholds',
        maxVertexGrid: MAX_VERTEX_GRID,
        maxTriangleGrid: MAX_TRIANGLE_GRID,
      },
      knownUnsupportedSourceChannels: {
        policy: 'Mixamo finger/thumb channels have no Sora counterparts and are explicitly excluded from transferred count',
        channels: [...new Set(sourceEvidence.flatMap((entry) => entry.unsupportedFingerChannels))].slice(0, 64),
      },
      sourceEvidence,
      combinations,
      stateSwitch,
      failures: failures.slice(0, 128),
      failureCount: failures.length,
    };
    console.log(JSON.stringify(report, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await server.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let sourceDir = null;
  try {
    sourceDir = parseSourceDir();
  } catch {
    // Keep the startup report machine-readable even when the CLI flag itself is malformed.
  }
  console.error(JSON.stringify({ status: 'DONE_WITH_CONCERNS', sourceDir, failureCount: 1, failures: [{ kind: 'validator-startup', message }] }, null, 2));
  process.exitCode = 1;
}
