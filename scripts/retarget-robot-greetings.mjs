#!/usr/bin/env node
// Offline rest-world delta retargeting, following retarget-uppercut.mjs. No source GLB writes.
// node scripts/retarget-robot-greetings.mjs '/path/to/animations'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = process.argv[2];
assert(sourceDirectory, 'Usage: node scripts/retarget-robot-greetings.mjs <FBX-directory>');
const targetPath = resolve(project, 'public/robot/robot3d.glb');
const outputPath = resolve(project, 'public/robot/greetings.json');
const hz = 60;
const greetings = [
  { sourceName: 'Quick Formal Bow', clipName: "Japan's Greeting" },
  { sourceName: 'Shaking Hands', clipName: 'Shaking Hands' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = name => THREE.PropertyBinding.sanitizeNodeName(name);
const worldQ = node => node.getWorldQuaternion(new THREE.Quaternion()).normalize();
const worldP = node => node.getWorldPosition(new THREE.Vector3());
const degrees = radians => radians * 180 / Math.PI;
const angle = (a, b) => degrees(a.clone().normalize().angleTo(b.clone().normalize()));
const max = values => Math.max(...values);

// The supplied animation-only FBXs contain no mesh/texture, so no browser shims are necessary.
function readSource(path) {
  const bytes = readFileSync(path);
  const group = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const bones = new Map();
  group.traverse(node => { if (node.isBone) bones.set(node.name, node); });
  group.updateMatrixWorld(true);
  assert.equal(group.animations.length, 1);
  assert.equal(group.animations[0].tracks.length, 54);
  return { bytes, group, bones, clip: group.animations[0] };
}

// Load actual GLB node TRS and independently check every joint against its inverse bind matrix.
// Mesh/image decoding is irrelevant to this offline skeleton-only conversion.
function readTarget(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  assert.equal(json.skins.length, 1);
  assert.equal(json.animations.length, 17);
  const skin = json.skins[0];
  assert.equal(skin.joints.length, 65);
  const joints = new Set(skin.joints);
  const nodes = json.nodes.map((definition, index) => {
    const node = joints.has(index) ? new THREE.Bone() : new THREE.Object3D();
    node.name = canonical(definition.name ?? `node_${index}`);
    if (definition.matrix) new THREE.Matrix4().fromArray(definition.matrix).decompose(node.position, node.quaternion, node.scale);
    else {
      if (definition.translation) node.position.fromArray(definition.translation);
      if (definition.rotation) node.quaternion.fromArray(definition.rotation);
      if (definition.scale) node.scale.fromArray(definition.scale);
    }
    return node;
  });
  json.nodes.forEach((node, i) => (node.children ?? []).forEach(child => nodes[i].add(nodes[child])));
  const group = new THREE.Group();
  for (const index of json.scenes[json.scene ?? 0].nodes) group.add(nodes[index]);
  group.updateMatrixWorld(true);
  const accessor = json.accessors[skin.inverseBindMatrices];
  assert.equal(accessor.componentType, 5126);
  assert.equal(accessor.type, 'MAT4');
  assert.equal(accessor.count, skin.joints.length);
  const view = json.bufferViews[accessor.bufferView];
  assert.equal(view.buffer, 0);
  const offset = 28 + jsonLength + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 64;
  const bindMatrixErrors = skin.joints.map((nodeIndex, i) => {
    const inverse = Array.from({ length: 16 }, (_, c) => bytes.readFloatLE(offset + i * stride + c * 4));
    const bind = new THREE.Matrix4().fromArray(inverse).invert();
    return max(bind.elements.map((value, c) => Math.abs(value - nodes[nodeIndex].matrixWorld.elements[c])));
  });
  assert(max(bindMatrixErrors) < 1e-4, 'GLB node rest is not its skin bind pose');
  const bones = [];
  group.traverse(node => { if (node.isBone) bones.push(node); }); // Parent before child.
  return { group, bones, bindMatrixMaxError: max(bindMatrixErrors), originalClips: json.animations.length };
}

function snapshot(bones) {
  return new Map([...bones].map(([name, node]) => [name, {
    p: worldP(node), q: worldQ(node), position: node.position.clone(),
    quaternion: node.quaternion.clone().normalize(), scale: node.scale.clone(),
  }]));
}
function stature(rest) {
  return rest.get('mixamorigHead').p.y - Math.min(rest.get('mixamorigLeftFoot').p.y, rest.get('mixamorigRightFoot').p.y);
}
function range(vectors) {
  return { min: [0, 1, 2].map(i => Math.min(...vectors.map(v => v.getComponent(i)))), max: [0, 1, 2].map(i => max(vectors.map(v => v.getComponent(i)))) };
}
const limbPairs = [
  ['Spine2', 'Head'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
];
const landmarkNames = ['Hips', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];

function convert(sourceName, clipName, targetBytes) {
  const input = readSource(resolve(sourceDirectory, sourceName + '.fbx'));
  const target = readTarget(targetBytes);
  const targetBones = new Map(target.bones.map(bone => [bone.name, bone]));
  // Capture fresh loader rest BEFORE creating an AnimationMixer; frame zero is not a bind pose.
  const sourceRest = snapshot(input.bones);
  const targetRest = snapshot(targetBones);
  const sourceHeight = stature(sourceRest), targetHeight = stature(targetRest);
  assert(sourceHeight > 100 && sourceHeight < 250, 'Expected centimeter-scale source');
  assert(targetHeight > 0.1 && targetHeight < 5, 'Unexpected target stature');
  const heightScale = targetHeight / sourceHeight;
  const sourceLeft = sourceRest.get('mixamorigLeftShoulder').p.clone().sub(sourceRest.get('mixamorigRightShoulder').p).setY(0).normalize();
  const targetLeft = targetRest.get('mixamorigLeftShoulder').p.clone().sub(targetRest.get('mixamorigRightShoulder').p).setY(0).normalize();
  const yaw = Math.atan2(-targetLeft.z, targetLeft.x) - Math.atan2(-sourceLeft.z, sourceLeft.x);
  const alignment = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const inverseAlignment = alignment.clone().invert();
  // Retarget frames must share limb directions, not just facing: this GLB has an A-pose
  // and the FBXs have a T-pose. Swing the target bind frame to the source bind direction
  // before applying the animated rest-world delta. Keep bind twist and all bone lengths.
  const bindSwings = new Map(target.bones.map(bone => [bone.name, new THREE.Quaternion()]));
  for (const side of ['Left', 'Right']) {
    const chains = [['Shoulder', 'Arm'], ['Arm', 'ForeArm'], ['ForeArm', 'Hand'], ['Hand', 'HandMiddle1']];
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      for (let segment = 1; segment <= 3; segment++) chains.push([`Hand${finger}${segment}`, `Hand${finger}${segment + 1}`]);
    }
    for (const [from, to] of chains) {
      const a = `mixamorig${side}${from}`, b = `mixamorig${side}${to}`;
      assert(sourceRest.has(b) && targetRest.has(b), `Missing rest landmark ${b}`);
      const sourceDirection = sourceRest.get(b).p.clone().sub(sourceRest.get(a).p).applyQuaternion(alignment).normalize();
      const targetDirection = targetRest.get(b).p.clone().sub(targetRest.get(a).p).normalize();
      bindSwings.set(a, new THREE.Quaternion().setFromUnitVectors(targetDirection, sourceDirection));
    }
  }
  const animatedNames = new Set(input.clip.tracks.filter(track => track.name.endsWith('.quaternion')).map(track => track.name.split('.')[0]));
  const coverage = input.clip.tracks.map(track => {
    const [bone, property] = track.name.split('.');
    assert(input.bones.has(bone));
    assert(property === 'quaternion' || (bone === 'mixamorigHips' && property === 'position'));
    // Target has one neck segment. Neck1's animation is included in source Head WORLD rotation.
    const targetBone = bone === 'mixamorigNeck1' ? 'mixamorigHead' : bone;
    assert(targetBones.has(targetBone), `Unmapped source track: ${track.name}`);
    return { source: track.name, target: `${targetBone}.${property}`, mode: bone === 'mixamorigNeck1' ? 'composed into head world orientation' : property === 'position' ? 'stature-scaled bind-relative displacement' : 'rest-world orientation delta' };
  });
  const sampleCount = Math.round(input.clip.duration * hz) + 1;
  const times = new Float32Array(Array.from({ length: sampleCount }, (_, i) => i * input.clip.duration / (sampleCount - 1)));
  const quaternionValues = new Map(target.bones.map(bone => [bone.name, []]));
  const hipValues = [], frames = [], limbErrors = [];
  const mixer = new THREE.AnimationMixer(input.group);
  const action = mixer.clipAction(input.clip).setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  let firstFrameRestDifference = 0;
  for (let i = 0; i < times.length; i++) {
    mixer.update(i === 0 ? 0 : times[i] - times[i - 1]);
    input.group.updateMatrixWorld(true);
    const sourceFrame = snapshot(input.bones);
    if (i === 0) firstFrameRestDifference = max([...animatedNames].map(bone => angle(sourceRest.get(bone).q, sourceFrame.get(bone).q)));
    const expectedWorld = new Map();
    for (const bone of target.bones) {
      const rest = targetRest.get(bone.name);
      const parentQ = expectedWorld.get(bone.parent.name) ?? worldQ(bone.parent);
      const mapped = animatedNames.has(bone.name);
      const desired = mapped
        ? alignment.clone().multiply(sourceFrame.get(bone.name).q).multiply(sourceRest.get(bone.name).q.clone().invert()).multiply(inverseAlignment).multiply(bindSwings.get(bone.name)).multiply(rest.q).normalize()
        : parentQ.clone().multiply(rest.quaternion).normalize();
      expectedWorld.set(bone.name, desired);
      const local = parentQ.clone().invert().multiply(desired).normalize();
      const values = quaternionValues.get(bone.name);
      if (values.length && local.dot(new THREE.Quaternion().fromArray(values, values.length - 4)) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      values.push(...local.toArray());
      bone.quaternion.copy(local);
    }
    const hip = targetBones.get('mixamorigHips');
    const displacement = sourceFrame.get('mixamorigHips').p.clone().sub(sourceRest.get('mixamorigHips').p).applyQuaternion(alignment).multiplyScalar(heightScale);
    hip.position.copy(hip.parent.worldToLocal(targetRest.get('mixamorigHips').p.clone().add(displacement)));
    hipValues.push(...hip.position.toArray());
    target.group.updateMatrixWorld(true);
    const targetFrame = snapshot(targetBones);
    const directionalErrors = limbPairs.map(([a, b]) => {
      const sourceDirection = sourceFrame.get(`mixamorig${b}`).p.clone().sub(sourceFrame.get(`mixamorig${a}`).p).applyQuaternion(alignment).normalize();
      const targetDirection = targetFrame.get(`mixamorig${b}`).p.clone().sub(targetFrame.get(`mixamorig${a}`).p).normalize();
      return degrees(sourceDirection.angleTo(targetDirection));
    });
    limbErrors.push(directionalErrors);
    frames.push({ source: sourceFrame, target: targetFrame, expectedWorld });
  }
  mixer.stopAllAction();
  const tracks = [];
  for (const bone of target.bones) {
    const rest = targetRest.get(bone.name);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, quaternionValues.get(bone.name)));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, bone.name === 'mixamorigHips' ? times : [0, input.clip.duration], bone.name === 'mixamorigHips' ? hipValues : [...rest.position.toArray(), ...rest.position.toArray()]));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.scale`, [0, input.clip.duration], [...rest.scale.toArray(), ...rest.scale.toArray()]));
  }
  const clip = new THREE.AnimationClip(clipName, input.clip.duration, tracks).optimize();
  assert.equal(clip.tracks.length, 195);
  assert(clip.validate());
  // Exercise serialized clips through Three's real mixer, not only the conversion arrays.
  const serialized = THREE.AnimationClip.toJSON(clip);
  // Mixer actions are keyed by clip UUID; omission makes both parsed clips alias in r169.
  // UUIDv8 carries a deterministic SHA-256-derived identity without random build noise.
  const identity = createHash('sha256').update(hash(input.bytes)).update(hash(targetBytes)).update(clipName).digest('hex');
  serialized.uuid = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-8${identity.slice(13, 16)}-${((parseInt(identity[16], 16) & 3) | 8).toString(16)}${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  const loaded = THREE.AnimationClip.parse(serialized);
  const outputMixer = new THREE.AnimationMixer(target.group);
  const outputAction = outputMixer.clipAction(loaded).setLoop(THREE.LoopOnce, 1);
  outputAction.clampWhenFinished = true;
  outputAction.play();
  const outputFrames = [];
  let worldOrientationError = 0, hipTransferError = 0, nonHipTranslationError = 0, boneLengthError = 0, scaleDelta = 0;
  for (let i = 0; i < times.length; i++) {
    outputMixer.update(i === 0 ? 0 : times[i] - times[i - 1]);
    target.group.updateMatrixWorld(true);
    for (const bone of target.bones) {
      const rest = targetRest.get(bone.name);
      worldOrientationError = Math.max(worldOrientationError, angle(worldQ(bone), frames[i].expectedWorld.get(bone.name)));
      if (bone.name !== 'mixamorigHips') {
        nonHipTranslationError = Math.max(nonHipTranslationError, bone.position.distanceTo(rest.position));
        boneLengthError = Math.max(boneLengthError, Math.abs(bone.position.length() - rest.position.length()));
      }
      scaleDelta = Math.max(scaleDelta, ...bone.scale.toArray().map(value => Math.abs(value - 1)));
    }
    hipTransferError = Math.max(hipTransferError, worldP(targetBones.get('mixamorigHips')).distanceTo(frames[i].target.get('mixamorigHips').p));
    outputFrames.push(snapshot(targetBones));
  }
  assert(worldOrientationError < 0.01);
  assert(hipTransferError < 1e-6 && nonHipTranslationError < 1e-7 && boneLengthError < 1e-7);
  const first = outputFrames[0], last = outputFrames.at(-1);
  const profile = { sourceName: clipName, label: clipName, motionClass: 'in-place', loop: false, duration: clip.duration,
    poseReturnDegrees: max(target.bones.map(bone => angle(first.get(bone.name).quaternion, last.get(bone.name).quaternion))),
    hipReturnH: first.get('mixamorigHips').p.distanceTo(last.get('mixamorigHips').p) / targetHeight, scaleDelta, tracks: tracks.length };
  assert(max(limbErrors.flatMap(row => row.slice(1, 5))) < 0.01, 'Arm direction retargeting lost source motion');
  const motion = samples => {
    const initial = samples[0];
    const excursions = samples.map(frame => angle(initial.get('mixamorigHead').q, frame.get('mixamorigHead').q));
    const peak = excursions.indexOf(max(excursions));
    return { headMaxRotationFromStartDegrees: excursions[peak], headPeakTime: times[peak],
      headMaxDrop: initial.get('mixamorigHead').p.y - Math.min(...samples.map(frame => frame.get('mixamorigHead').p.y)),
      rightHandForwardReachFromHips: max(samples.map(frame => frame.get('mixamorigRightHand').p.z - frame.get('mixamorigHips').p.z)),
      rightHandRange: range(samples.map(frame => frame.get('mixamorigRightHand').p)) };
  };
  const behavior = { source: motion(frames.map(frame => frame.source)), target: motion(outputFrames) };
  const bindFrameDifferences = target.bones.filter(bone => sourceRest.has(bone.name)).map(bone => ({ bone: bone.name, degrees: angle(alignment.clone().multiply(sourceRest.get(bone.name).q), targetRest.get(bone.name).q) }));
  const landmarkSamples = [0, Math.round((times.length - 1) / 4), Math.round((times.length - 1) / 2), Math.round(3 * (times.length - 1) / 4), times.length - 1].map(i => ({
    time: times[i], source: Object.fromEntries(landmarkNames.map(n => [n, frames[i].source.get(`mixamorig${n}`).p.toArray()])),
    target: Object.fromEntries(landmarkNames.map(n => [n, frames[i].target.get(`mixamorig${n}`).p.toArray()])),
  }));
  const evidence = { file: sourceName + '.fbx', sha256: hash(input.bytes), bytes: input.bytes.length,
    sourceTracks: input.clip.tracks.length, coveredTracks: coverage.length, coverage,
    sourceRest: 'FBX model transforms before any AnimationMixer; animation-only FBX has no skin inverse bind matrices',
    sourceBones: input.bones.size, targetBones: target.bones.length, sampleCount, sampleHz: hz, sourceHeight, targetHeight, heightScale, yawDegrees: degrees(yaw),
    firstFrameVsRestMaxDegrees: firstFrameRestDifference, bindFrameDifferences, behavior,
    bindDirectionSwings: [...bindSwings].filter(([, q]) => q.angleTo(new THREE.Quaternion()) > 1e-8).map(([bone, q]) => ({ bone, degrees: degrees(q.angleTo(new THREE.Quaternion())) })),
    targetBindMatrixMaxError: target.bindMatrixMaxError,
    sourceHipRange: range(frames.map(frame => frame.source.get('mixamorigHips').p)), targetHipRange: range(frames.map(frame => frame.target.get('mixamorigHips').p)),
    worldOrientationMaxErrorDegrees: worldOrientationError, hipTransferMaxError: hipTransferError, nonHipTranslationMaxError: nonHipTranslationError, boneLengthMaxError: boneLengthError,
    limbDirectionErrorDegrees: limbPairs.map((pair, index) => ({ pair, min: Math.min(...limbErrors.map(row => row[index])), max: max(limbErrors.map(row => row[index])) })),
    landmarkSamples,
  };
  console.log(JSON.stringify({ profile, behavior, sourceSha256: evidence.sha256, sampleCount, heightScale, targetBindMatrixMaxError: target.bindMatrixMaxError, firstFrameRestDifference, worldOrientationError, hipTransferError, nonHipTranslationError, boneLengthError, armDirectionMaxErrorDegrees: max(limbErrors.flatMap(row => row.slice(1, 5))) }, null, 2));
  return { serialized, profile, evidence };
}

const targetBytes = readFileSync(targetPath);
const results = greetings.map(({ sourceName, clipName }) => convert(sourceName, clipName, targetBytes));
const combinedMixer = new THREE.AnimationMixer(readTarget(targetBytes).group);
const combinedActions = results.map(result => combinedMixer.clipAction(THREE.AnimationClip.parse(result.serialized)));
assert.notEqual(combinedActions[0], combinedActions[1], 'Greeting clips alias in the mixer');
assert.deepEqual(combinedActions.map(action => action.getClip().name), greetings.map(greeting => greeting.clipName));
const output = { clips: results.map(result => result.serialized), profiles: results.map(result => result.profile), provenance: {
  converter: 'scripts/retarget-robot-greetings.mjs', threeRevision: THREE.REVISION,
  target: { file: basename(targetPath), sha256: hash(targetBytes), bytes: targetBytes.length, originalClips: 17, bones: 65 },
  method: 'worldAnimated * inverse(worldRest), yaw conjugation, measured arm/hand/finger bind-direction swing, target world bind; parent inverse to local; hips bind-relative displacement scaled by head-to-foot stature',
  metricDefinitions: { poseReturnDegrees: 'maximum local quaternion endpoint angle across all 65 bones', hipReturnH: 'world hips endpoint distance / target bind Head-to-lowest-Foot height', scaleDelta: 'maximum absolute local scale component minus one; constant bind scales preserved', motionClass: 'in-place gesture: source root motion preserved, no locomotion extraction' },
  limitations: ['No partner character for the solo handshake source.', 'No IK/contact cleanup: differing proportions and uncorrected torso/leg bind directions remain.', 'Neck1 has no target counterpart; its rotation is composed into the target Head world orientation.'],
  sources: results.map(result => result.evidence),
} };
const text = JSON.stringify(output) + '\n';
writeFileSync(outputPath, text);
assert.equal(hash(readFileSync(targetPath)), output.provenance.target.sha256, 'Source GLB changed');
console.log(JSON.stringify({ output: outputPath, bytes: Buffer.byteLength(text), sha256: hash(Buffer.from(text)), target: output.provenance.target }, null, 2));
