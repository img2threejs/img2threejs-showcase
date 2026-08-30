import * as THREE from 'three';

/**
 * GATE R1 — a clip that exists is not a clip that runs.
 *
 * The failure this catches is specific and it is silent: a retargeted clip can ship with the right
 * name, the right duration and 41 tracks, and still move nothing, because its track names do not
 * resolve to bones in THIS skeleton, or because every keyframe holds the bind pose. Counting clips
 * proves none of that. Playing one and looking at it proves it for one clip.
 *
 * So each clip is seeked to at least five times across its duration and the SKIN is measured, not
 * the skeleton: at every sampled time a fixed set of vertices is pushed through
 * `applyBoneTransform` — the same maths the shader runs — and compared with the same vertices in
 * the true bind pose. Two numbers come out:
 *
 *   maxSampledBindingDelta   how far the skin moves away from bind. Zero means the clip does not
 *                            drive this binding at all.
 *   maxInterSampleDelta      how far the skin moves BETWEEN consecutive samples. A clip can park
 *                            the figure in a fixed non-bind pose and score well on the first
 *                            number while being frozen; this one catches that.
 *
 * A clip that cannot be measured is reported `unevaluated` with the input it lacked. It is never
 * reported as a pass. There is no default-pass branch in this file.
 */

export interface ClipProbeResult {
  clip: string;
  duration: number;
  sampledTimes: number[];
  tracksTotal: number;
  tracksResolvedToBone: number;
  unresolvedTrackNames: string[];
  bonesDriven: number;
  sampledVertices: number;
  /** World units. */
  maxSampledBindingDelta: number;
  /** As a fraction of the measured figure height — the comparable number across models. */
  maxSampledBindingDeltaFraction: number;
  /** Time, in seconds, at which the maximum was observed. */
  maxAtTime: number;
  /** World units of movement between two consecutive samples. */
  maxInterSampleDelta: number;
  verdict: 'pass' | 'fail' | 'unevaluated';
  missingInputs: string[];
  note: string;
}

export interface ClipProbeReport {
  figureHeight: number;
  /** What the bind pose is, so a reader can interpret the deltas rather than guess at them. */
  bindPoseNote: string;
  boneCount: number;
  vertexCount: number;
  samplesPerClip: number;
  /** A clip must move the skin at least this fraction of the figure height to pass. */
  motionThresholdFraction: number;
  results: ClipProbeResult[];
  passed: number;
  failed: number;
  unevaluated: number;
  /** The largest binding delta over every clip — the headline number the brief asks for. */
  maxSampledBindingDelta: number;
}

export interface ProbeOptions {
  /** At least 5. The gate refuses fewer. */
  samplesPerClip?: number;
  /** How many vertices to push through the skinning maths per sample. */
  vertexSamples?: number;
  /** Fraction of figure height a clip must move the skin to count as running. */
  motionThresholdFraction?: number;
  /** Used to express deltas in world units; measured off the rig, not assumed. */
  figureHeight: number;
}

/**
 * Probe every clip against a bound skinned mesh.
 *
 * Leaves the skeleton in its bind pose and the mixers stopped; the caller is free to start its own
 * animator afterwards.
 */
export function probeClips(
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
  options: ProbeOptions,
): ClipProbeReport {
  const samplesPerClip = Math.max(5, options.samplesPerClip ?? 7);
  const vertexSamples = options.vertexSamples ?? 900;
  const motionThresholdFraction = options.motionThresholdFraction ?? 0.005;
  const { figureHeight } = options;

  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const vertexCount = position.count;
  const boneNames = new Set(mesh.skeleton.bones.map((b) => b.name));

  // Evenly spaced rather than random: the same vertices are measured on every run and on every
  // clip, so two reports are comparable.
  const stride = Math.max(1, Math.floor(vertexCount / vertexSamples));
  const indices: number[] = [];
  for (let i = 0; i < vertexCount; i += stride) indices.push(i);

  // World scale, so a delta is reported in the units the figure is measured in.
  const worldScale = mesh.getWorldScale(new THREE.Vector3()).x;

  const readPose = (out: Float32Array): void => {
    mesh.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    for (let k = 0; k < indices.length; k += 1) {
      v.fromBufferAttribute(position, indices[k]);
      mesh.applyBoneTransform(indices[k], v);
      out[k * 3] = v.x;
      out[k * 3 + 1] = v.y;
      out[k * 3 + 2] = v.z;
    }
  };

  // The reference is the TRUE bind pose from the inverse bind matrices, not "whatever the bones
  // happened to be left at". `Skeleton.pose()` is what puts them there.
  mesh.skeleton.pose();
  const bind = new Float32Array(indices.length * 3);
  readPose(bind);

  const current = new Float32Array(indices.length * 3);
  const previous = new Float32Array(indices.length * 3);
  const results: ClipProbeResult[] = [];

  for (const clip of clips) {
    const tracksTotal = clip.tracks.length;
    const unresolved: string[] = [];
    const driven = new Set<string>();
    for (const track of clip.tracks) {
      const boneName = track.name.split('.')[0];
      if (boneNames.has(boneName)) driven.add(boneName);
      else unresolved.push(track.name);
    }

    const missingInputs: string[] = [];
    if (tracksTotal === 0) missingInputs.push('clip has no tracks');
    if (clip.duration <= 0) missingInputs.push('clip duration is zero, so there is nothing to seek across');
    if (unresolved.length === tracksTotal && tracksTotal > 0) {
      missingInputs.push(`none of the ${tracksTotal} track names resolve to a bone in this skeleton`);
    }
    if (indices.length === 0) missingInputs.push('no vertices to sample');

    if (missingInputs.length > 0) {
      results.push({
        clip: clip.name,
        duration: clip.duration,
        sampledTimes: [],
        tracksTotal,
        tracksResolvedToBone: tracksTotal - unresolved.length,
        unresolvedTrackNames: unresolved.slice(0, 8),
        bonesDriven: driven.size,
        sampledVertices: indices.length,
        maxSampledBindingDelta: 0,
        maxSampledBindingDeltaFraction: 0,
        maxAtTime: 0,
        maxInterSampleDelta: 0,
        verdict: 'unevaluated',
        missingInputs,
        note: 'not measured — see missingInputs. This is not a pass.',
      });
      continue;
    }

    const mixer = new THREE.AnimationMixer(mesh);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();

    const times: number[] = [];
    let maxDelta = 0;
    let maxAt = 0;
    let maxStep = 0;

    for (let s = 0; s < samplesPerClip; s += 1) {
      // Endpoints included: the first and last frame are where a bad retarget usually shows.
      const t = (clip.duration * s) / (samplesPerClip - 1);
      times.push(Number(t.toFixed(4)));
      mixer.setTime(t);
      readPose(current);

      let delta = 0;
      let step = 0;
      for (let k = 0; k < indices.length; k += 1) {
        const i3 = k * 3;
        const dx = current[i3] - bind[i3];
        const dy = current[i3 + 1] - bind[i3 + 1];
        const dz = current[i3 + 2] - bind[i3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > delta) delta = d;
        if (s > 0) {
          const sx = current[i3] - previous[i3];
          const sy = current[i3 + 1] - previous[i3 + 1];
          const sz = current[i3 + 2] - previous[i3 + 2];
          const ds = Math.sqrt(sx * sx + sy * sy + sz * sz);
          if (ds > step) step = ds;
        }
      }
      if (delta > maxDelta) {
        maxDelta = delta;
        maxAt = t;
      }
      if (step > maxStep) maxStep = step;
      previous.set(current);
    }

    action.stop();
    mixer.stopAllAction();
    mixer.uncacheClip(clip);

    const worldDelta = maxDelta * worldScale;
    const worldStep = maxStep * worldScale;
    const fraction = worldDelta / figureHeight;
    const moves = fraction >= motionThresholdFraction;
    const animates = (worldStep / figureHeight) >= motionThresholdFraction * 0.2;
    const allResolve = unresolved.length === 0;

    const verdict: ClipProbeResult['verdict'] = moves && animates && allResolve ? 'pass' : 'fail';
    const why = verdict === 'pass'
      ? `skin moves ${(fraction * 100).toFixed(1)}% of figure height away from bind, and ${(worldStep / figureHeight * 100).toFixed(2)}% between samples`
      : [
        !moves && `skin never leaves bind by more than ${(fraction * 100).toFixed(3)}% of figure height (threshold ${(motionThresholdFraction * 100).toFixed(1)}%)`,
        !animates && 'the pose barely changes between samples — the clip parks the figure rather than animating it',
        !allResolve && `${unresolved.length} of ${tracksTotal} tracks do not resolve to a bone`,
      ].filter(Boolean).join('; ');

    results.push({
      clip: clip.name,
      duration: clip.duration,
      sampledTimes: times,
      tracksTotal,
      tracksResolvedToBone: tracksTotal - unresolved.length,
      unresolvedTrackNames: unresolved.slice(0, 8),
      bonesDriven: driven.size,
      sampledVertices: indices.length,
      maxSampledBindingDelta: Number(worldDelta.toFixed(6)),
      maxSampledBindingDeltaFraction: Number(fraction.toFixed(6)),
      maxAtTime: maxAt,
      maxInterSampleDelta: Number(worldStep.toFixed(6)),
      verdict,
      missingInputs: [],
      note: why,
    });
  }

  // Hand the mesh back the way it was found.
  mesh.skeleton.pose();
  mesh.updateMatrixWorld(true);

  // The scale a reader needs to interpret bindDelta: this rig binds in a T-POSE, so any clip that
  // merely lowers the arms already displaces a fingertip by half an arm span. Deltas above 100% of
  // figure height are therefore normal here and are NOT evidence of anything being wrong; the
  // number that separates a running clip from a parked one is maxInterSampleDelta.
  const bindBox = new THREE.Box3();
  const bv = new THREE.Vector3();
  for (let k = 0; k < indices.length; k += 1) {
    bindBox.expandByPoint(bv.set(bind[k * 3], bind[k * 3 + 1], bind[k * 3 + 2]));
  }
  const bindSize = bindBox.getSize(new THREE.Vector3()).multiplyScalar(worldScale);
  const bindSpan = Math.max(bindSize.x, bindSize.z);
  const bindPoseNote = `bind pose spans ${bindSpan.toFixed(3)} laterally against ${bindSize.y.toFixed(3)} tall`
    + ` — a T-pose. Lowering the arms alone displaces a fingertip by about ${(bindSpan / 2).toFixed(2)}`
    + ` units, so a bindDelta over 100% of figure height is expected and is not a defect.`;

  return {
    figureHeight,
    bindPoseNote,
    boneCount: mesh.skeleton.bones.length,
    vertexCount,
    samplesPerClip,
    motionThresholdFraction,
    results,
    passed: results.filter((r) => r.verdict === 'pass').length,
    failed: results.filter((r) => r.verdict === 'fail').length,
    unevaluated: results.filter((r) => r.verdict === 'unevaluated').length,
    maxSampledBindingDelta: results.reduce((m, r) => Math.max(m, r.maxSampledBindingDelta), 0),
  };
}

/** Plain-text report — the same lines whether it ran in Node or in the browser console. */
export function formatProbeReport(report: ClipProbeReport): string[] {
  const lines = [
    `GATE R1 — clip binding probe`,
    `  ${report.results.length} clips, ${report.samplesPerClip} seeks each, `
      + `${report.results[0]?.sampledVertices ?? 0} of ${report.vertexCount} vertices measured per seek`,
    `  skeleton ${report.boneCount} bones, figure height ${report.figureHeight.toFixed(4)}`,
    `  ${report.bindPoseNote}`,
    `  pass threshold: skin must leave bind by ${(report.motionThresholdFraction * 100).toFixed(1)}% of figure height`,
    '',
    `  ${'clip'.padEnd(30)} ${'dur'.padStart(6)} ${'trk'.padStart(6)} ${'bindΔ'.padStart(9)} ${'%h'.padStart(7)} ${'stepΔ'.padStart(9)}  verdict`,
  ];
  for (const r of report.results) {
    lines.push(
      `  ${r.clip.padEnd(30)} ${r.duration.toFixed(2).padStart(6)} `
      + `${`${r.tracksResolvedToBone}/${r.tracksTotal}`.padStart(6)} `
      + `${r.maxSampledBindingDelta.toFixed(4).padStart(9)} `
      + `${(r.maxSampledBindingDeltaFraction * 100).toFixed(2).padStart(7)} `
      + `${r.maxInterSampleDelta.toFixed(4).padStart(9)}  ${r.verdict}`,
    );
    if (r.verdict !== 'pass') lines.push(`      ${r.verdict === 'unevaluated' ? r.missingInputs.join('; ') : r.note}`);
  }
  lines.push(
    '',
    `  maxSampledBindingDelta = ${report.maxSampledBindingDelta.toFixed(6)} world units `
      + `(${(report.maxSampledBindingDelta / report.figureHeight * 100).toFixed(1)}% of figure height)`,
    `  ${report.passed} pass, ${report.failed} fail, ${report.unevaluated} unevaluated`,
  );
  return lines;
}
