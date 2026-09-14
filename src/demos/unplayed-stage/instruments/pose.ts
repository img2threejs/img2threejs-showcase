/**
 * Pure, absolute-time pose helpers for the M1 fixture.
 *
 * These functions intentionally know nothing about Three.js.  A seek can
 * therefore evaluate the same pose as a continuously rendered frame without
 * replaying any of the earlier frames.
 */

export interface PoseNoteEvent {
  readonly id?: string;
  readonly onsetSeconds: number;
  readonly releaseSeconds: number;
  readonly midiPitch?: number;
  readonly velocity: number;
}

export interface PoseControllerEvent {
  readonly timeSeconds: number;
  readonly value: number;
}

export type PianoKeyPhase = 'idle' | 'attack' | 'held' | 'release';

export interface PianoKeyPose {
  readonly depression: number;
  readonly active: boolean;
  readonly velocity: number;
  readonly phase: PianoKeyPhase;
  readonly eventId?: string;
}

export type SnareStickPhase = 'idle' | 'preparation' | 'contact' | 'rebound';

export interface SnareStickPose {
  /** Rotation around the stick pivot, in radians. Zero is the contact pose. */
  readonly angleRadians: number;
  readonly active: boolean;
  readonly impact: number;
  readonly phase: SnareStickPhase;
  readonly eventId?: string;
}

export const PIANO_PREPARATION_SECONDS = 0.025;
/** Backwards-compatible name for callers that call preparation an attack. */
export const PIANO_ATTACK_SECONDS = PIANO_PREPARATION_SECONDS;
export const PIANO_RELEASE_SECONDS = 0.08;
export const SNARE_PREPARATION_SECONDS = 0.1;
export const SNARE_CONTACT_SECONDS = 0.025;
export const SNARE_REBOUND_SECONDS = 0.22;
export const SNARE_RAISED_ANGLE_RADIANS = -0.62;

const EPSILON = 1e-9;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function eventSortKey(event: PoseNoteEvent): string {
  return event.id ?? '';
}

/**
 * Evaluate one piano note.  Sustain is deliberately absent from this
 * function: a pedal can keep the sound alive, but it never prevents the key
 * from returning to its rest position at releaseSeconds.
 */
export function evaluatePianoKeyPose(
  timeSeconds: number,
  event: PoseNoteEvent,
): PianoKeyPose {
  const time = finiteTime(timeSeconds);
  const onset = event.onsetSeconds;
  const release = Math.max(onset, event.releaseSeconds);
  const duration = Math.max(release - onset, EPSILON);
  const preparationSeconds = Math.min(
    PIANO_PREPARATION_SECONDS,
    duration * 0.35,
  );
  const releaseSeconds = Math.min(PIANO_RELEASE_SECONDS, duration * 0.35);
  const releaseStart = Math.max(onset, release - releaseSeconds);
  const velocity = clamp01(event.velocity);

  if (time < onset - preparationSeconds) {
    return {
      depression: 0,
      active: false,
      velocity,
      phase: 'idle',
      eventId: event.id,
    };
  }

  if (time >= release) {
    return {
      depression: 0,
      active: false,
      velocity,
      phase: 'idle',
      eventId: event.id,
    };
  }

  if (time < onset) {
    const attack = smoothStep(
      (time - (onset - preparationSeconds)) /
        Math.max(preparationSeconds, EPSILON),
    );
    return {
      depression: attack * velocity,
      active: true,
      velocity,
      phase: 'attack',
      eventId: event.id,
    };
  }

  if (time < releaseStart) {
    return {
      depression: velocity,
      active: true,
      velocity,
      phase: 'held',
      eventId: event.id,
    };
  }

  const releaseProgress = smoothStep(
    (time - releaseStart) / Math.max(release - releaseStart, EPSILON),
  );
  return {
    depression: velocity * (1 - releaseProgress),
    active: true,
    velocity,
    phase: 'release',
    eventId: event.id,
  };
}

/**
 * Evaluate a key from all of its scheduled events.  Overlapping events are
 * combined by taking the strongest current depression, which avoids a retrigger
 * causing a visible key pop while remaining deterministic.
 */
export function evaluatePianoKeyPoseAtTime(
  timeSeconds: number,
  events: ReadonlyArray<PoseNoteEvent>,
): PianoKeyPose {
  let result: PianoKeyPose = {
    depression: 0,
    active: false,
    velocity: 0,
    phase: 'idle',
  };

  for (const event of events) {
    const pose = evaluatePianoKeyPose(timeSeconds, event);
    if (
      pose.depression > result.depression + EPSILON ||
      (pose.active && !result.active)
    ) {
      result = pose;
    }
  }

  return result;
}

/** Return the last sustain value at an absolute transport time. */
export function evaluateSustainValue(
  timeSeconds: number,
  events: ReadonlyArray<PoseControllerEvent>,
): 0 | 1 {
  const time = finiteTime(timeSeconds);
  let value: 0 | 1 = 0;
  let latestTime = -Infinity;

  for (const event of events) {
    if (
      Number.isFinite(event.timeSeconds) &&
      event.timeSeconds <= time + EPSILON &&
      event.timeSeconds >= latestTime
    ) {
      latestTime = event.timeSeconds;
      value = event.value >= 0.5 ? 1 : 0;
    }
  }

  return value;
}

function idleSnarePose(eventId?: string): SnareStickPose {
  return {
    angleRadians: SNARE_RAISED_ANGLE_RADIANS,
    active: false,
    impact: 0,
    phase: 'idle',
    eventId,
  };
}

/**
 * Evaluate one snare stroke.  The stick is raised before an onset, reaches
 * the explicit contact pose at the onset, and then rebounds to its raised
 * pose.  No frame delta or timer state is used.
 */
export function evaluateSnareStickPose(
  timeSeconds: number,
  event: PoseNoteEvent,
): SnareStickPose {
  const time = finiteTime(timeSeconds);
  const onset = event.onsetSeconds;
  const preparationStart = onset - SNARE_PREPARATION_SECONDS;
  const contactEnd = onset + SNARE_CONTACT_SECONDS;
  const reboundEnd = onset + SNARE_REBOUND_SECONDS;
  const velocity = clamp01(event.velocity);

  if (time < preparationStart || time >= reboundEnd) {
    return idleSnarePose(event.id);
  }

  if (time < onset) {
    const progress = smoothStep(
      (time - preparationStart) / SNARE_PREPARATION_SECONDS,
    );
    return {
      angleRadians:
        SNARE_RAISED_ANGLE_RADIANS * (1 - progress),
      active: true,
      impact: 0,
      phase: 'preparation',
      eventId: event.id,
    };
  }

  if (time < contactEnd) {
    return {
      angleRadians: 0,
      active: true,
      impact: velocity,
      phase: 'contact',
      eventId: event.id,
    };
  }

  const reboundProgress = smoothStep(
    (time - contactEnd) / Math.max(reboundEnd - contactEnd, EPSILON),
  );
  return {
    angleRadians: SNARE_RAISED_ANGLE_RADIANS * reboundProgress,
    active: true,
    impact: velocity * (1 - reboundProgress),
    phase: 'rebound',
    eventId: event.id,
  };
}

/**
 * Pick the event that should currently drive the single fixture stick.  A
 * future stroke is selected during its preparation window; otherwise the most
 * recent stroke owns the stick until its rebound completes.
 */
export function evaluateSnareStickPoseAtTime(
  timeSeconds: number,
  events: ReadonlyArray<PoseNoteEvent>,
): SnareStickPose {
  const time = finiteTime(timeSeconds);
  let contact: PoseNoteEvent | undefined;
  let preparation: PoseNoteEvent | undefined;
  let rebound: PoseNoteEvent | undefined;

  for (const event of events) {
    const preparationStart = event.onsetSeconds - SNARE_PREPARATION_SECONDS;
    const contactEnd = event.onsetSeconds + SNARE_CONTACT_SECONDS;
    const reboundEnd = event.onsetSeconds + SNARE_REBOUND_SECONDS;
    if (time < preparationStart || time >= reboundEnd) continue;

    if (time >= event.onsetSeconds && time < contactEnd) {
      const sameOnset =
        contact !== undefined &&
        Math.abs(event.onsetSeconds - contact.onsetSeconds) <= EPSILON;
      if (
        !contact ||
        event.onsetSeconds > contact.onsetSeconds ||
        (sameOnset &&
          contact !== undefined &&
          eventSortKey(event) > eventSortKey(contact))
      ) {
        contact = event;
      }
    } else if (time < event.onsetSeconds && (
      !preparation ||
      event.onsetSeconds < preparation.onsetSeconds ||
      (Math.abs(event.onsetSeconds - preparation.onsetSeconds) <= EPSILON &&
        eventSortKey(event) < eventSortKey(preparation))
    )) {
      preparation = event;
    } else if (time >= contactEnd) {
      const sameOnset =
        rebound !== undefined &&
        Math.abs(event.onsetSeconds - rebound.onsetSeconds) <= EPSILON;
      if (
        !rebound ||
        event.onsetSeconds > rebound.onsetSeconds ||
        (sameOnset &&
          rebound !== undefined &&
          eventSortKey(event) > eventSortKey(rebound))
      ) {
        rebound = event;
      }
    }
  }

  const selected = contact ?? preparation ?? rebound;
  return selected ? evaluateSnareStickPose(time, selected) : idleSnarePose();
}
