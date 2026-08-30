import * as THREE from 'three';
import type { RigFrame } from './rigFrame';
import type { SocketRig } from './sockets';

/**
 * Find the moment in a clip where a limb actually strikes.
 *
 * Cue times used to be guesses — "the arm probably extends around 40% in" — and they were wrong in
 * a way nothing caught: `preset:biped:fire` turned out to be a STATIC AIMING POSE whose hand never
 * moves and never points where the torso does, so a bolt released at 40% left along an axis the
 * animation had nothing to do with. Gate R1 had already reported that clip with by far the lowest
 * inter-sample delta of the sixteen; this is the instrument that explains why.
 *
 * The scan works the same way Gate R1 does, and for the same reason: it SEEKS the clip on a probe
 * mixer rather than watching it play. Sampling a playing clip against wall time is at the mercy of
 * cross-fades, frame pacing and time scaling — measurements taken that way disagreed with
 * themselves between runs. Seeking is deterministic and frame-rate independent.
 *
 * A strike is scored as: pointing along the body's forward axis, moving fast, and not aimed at the
 * sky. Velocity comes from differencing two seeks a small step apart, so it is the clip's own
 * velocity at that time rather than whatever the renderer managed last frame.
 */

export interface CueCandidate {
  clip: string;
  socket: string;
  /** Normalised time through the clip — the number that goes straight into a cue. */
  at: number;
  /** Component of the aim along the body's forward axis, -1..1. */
  forward: number;
  /** Vertical component of the aim. Negative points at the floor. */
  up: number;
  /** World units per second. */
  speed: number;
  score: number;
}

export interface CueScanOptions {
  /** Seeks per clip. */
  samples?: number;
  /** Sockets to score. Each needs an `axisFrom` bone or it is skipped. */
  sockets: readonly string[];
  /** Minimum separation between two reported strikes, in normalised clip time. */
  separation?: number;
  /** How many strikes to report per clip and socket. */
  perSocket?: number;
}

export function scanCues(
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
  sockets: SocketRig,
  frame: RigFrame,
  options: CueScanOptions,
): CueCandidate[] {
  const samples = options.samples ?? 160;
  const separation = options.separation ?? 0.1;
  const perSocket = options.perSocket ?? 3;

  const tracked = options.sockets
    .map((id) => ({ id, socket: sockets.get(id), from: sockets.get(id).def.axisFrom }))
    .filter((s): s is { id: string; socket: ReturnType<SocketRig['get']>; from: string } => Boolean(s.from));

  const here = new THREE.Vector3();
  const later = new THREE.Vector3();
  const root = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const out: CueCandidate[] = [];

  for (const clip of clips) {
    if (clip.duration <= 0) continue;
    const mixer = new THREE.AnimationMixer(mesh);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();

    // Matched to the runtime smoother's time constant (1/26 s). At the 0.1s this started with, the
    // scan measured a much smoother velocity than the live tracker ever sees, and the cue it picked
    // did not correspond to the aim the runtime had at that moment.
    const step = Math.min(1 / 26, clip.duration / 12);

    const rows: CueCandidate[] = [];
    for (let s = 0; s < samples; s += 1) {
      const t = (clip.duration * s) / (samples - 1);
      // The forward difference needs a full step of clip left. Clamping the second seek to the end
      // instead and still dividing by the whole step inflates the speed as the clip runs out — it
      // reported 28.9 units per second at t = 0.987 on a clip whose real peak is 4.4.
      if (t + step > clip.duration) break;
      for (const limb of tracked) {
        mixer.setTime(t);
        mesh.updateMatrixWorld(true);
        limb.socket.worldPosition(here);
        root.setFromMatrixPosition(frame.bone(limb.from).matrixWorld);
        axis.subVectors(here, root);
        if (axis.lengthSq() < 1e-10) continue;
        axis.normalize();

        mixer.setTime(t + step);
        mesh.updateMatrixWorld(true);
        limb.socket.worldPosition(later);
        velocity.subVectors(later, here).divideScalar(step);
        const speed = velocity.length();

        // Same blend AND the same cap the casting path uses, so a scanned cue and the live launch
        // aim agree. Scoring with a different cap than the runtime fires with is how a cue that
        // scanned as level ended up launching skyward.
        const weight = Math.min(0.3, speed / (frame.figureHeight * 2.2));
        aim.copy(axis).multiplyScalar(1 - weight);
        if (speed > 1e-4) aim.addScaledVector(velocity, weight / speed);
        if (aim.lengthSq() < 1e-10) aim.copy(axis);
        aim.normalize();

        const forward = aim.dot(frame.forward);
        const up = aim.y;
        // Reject anything pointing backwards or at the sky outright; among the rest, prefer the
        // fastest and most forward.
        const score = forward < 0.55 || up > 0.35
          ? -1
          : forward * 2 + Math.min(speed / (frame.figureHeight * 3), 1) - Math.max(0, up) * 1.5;
        rows.push({
          clip: clip.name,
          socket: limb.id,
          at: Number((t / clip.duration).toFixed(3)),
          forward: Number(forward.toFixed(3)),
          up: Number(up.toFixed(3)),
          speed: Number(speed.toFixed(3)),
          score: Number(score.toFixed(3)),
        });
      }
    }

    action.stop();
    mixer.stopAllAction();
    mixer.uncacheClip(clip);

    for (const limb of tracked) {
      const mine = rows.filter((r) => r.socket === limb.id && r.score > 0).sort((a, b) => b.score - a.score);
      const chosen: CueCandidate[] = [];
      for (const row of mine) {
        if (chosen.length >= perSocket) break;
        if (chosen.some((c) => Math.abs(c.at - row.at) < separation)) continue;
        chosen.push(row);
      }
      out.push(...chosen.sort((a, b) => a.at - b.at));
    }
  }

  mesh.skeleton.pose();
  mesh.updateMatrixWorld(true);
  return out;
}

/** One line per strike, for the console. */
export function formatCueScan(candidates: readonly CueCandidate[]): string[] {
  return candidates.map((c) =>
    `${c.clip.replace('preset:biped:', '').padEnd(16)} ${c.socket.padEnd(22)} `
    + `at ${c.at.toFixed(3)}  fwd ${c.forward.toFixed(2).padStart(5)}  up ${c.up.toFixed(2).padStart(5)}  `
    + `speed ${c.speed.toFixed(2).padStart(5)}  score ${c.score.toFixed(2)}`);
}
