import * as THREE from 'three';

import type { NoteEvent } from '../music/ScoreLoader';

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const DEFAULT_TIP_LENGTH = 0.4;
const PREPARATION_SECONDS = 0.14;
const REBOUND_SECONDS = 0.18;
const GRIP_LATERAL_OFFSET = 0.30;
const GRIP_VERTICAL_OFFSET = 0.34;
const GRIP_PLAYER_SIDE_OFFSET = 0.62;
const GRIP_FOLLOW = 0.68;
const EPSILON = 1e-9;
const CLEARANCE_MARGIN = 0.045;
const CRASH_PREPARATION_SPLIT = 0.70;
const CRASH_STAGING_DISTANCE = 0.30;
const CRASH_EXIT_SPLIT = 0.28;
const CRASH_INITIAL_PREPARATION_SECONDS = 0.22;
const CRASH_REBOUND_SECONDS = 0.45;
// Common musical gaps through a dotted half beat are played as one stroke
// between the two real surfaces. A longer pause retains the visible return to
// the player's rest position.
const COMPACT_TRANSITION_MAX_GAP = 1.50;

export interface KickBeaterContact {
  readonly restRotationX: number;
  readonly contactRotationX: number;
}

/**
 * A bounded local collision envelope used only to route a hand stroke around
 * authored drum hardware.  It is deliberately a primitive envelope rather
 * than a general physics system.
 */
export interface DrumMotionObstacle {
  readonly id: string;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly minY: number;
  readonly maxY: number;
  /** Shaft/tip radius plus a small visual clearance margin. */
  readonly clearance: number;
  /** Optional target-local upper-surface normal for a tangent approach. */
  readonly normalLocal?: readonly [number, number, number];
}

export interface DrumMechanicsHost {
  readonly root: THREE.Group;
  readonly hitAnchors: Map<string, THREE.Vector3>;
  readonly sticks: Map<'left' | 'right', THREE.Group>;
  readonly kickBeater: THREE.Object3D;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function tangentApproach(value: number): number {
  // Keep a measurable final normal approach in the last sub-millisecond
  // before contact. A pure smoothstep has zero endpoint velocity and leaves
  // a dense stroke visually frozen before the hit.
  const t = clamp01(value);
  return t * 0.5 + smoothStep(t) * 0.5;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function quadraticBezier(
  start: THREE.Vector3,
  control: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
): THREE.Vector3 {
  const t = clamp01(progress);
  const oneMinus = 1 - t;
  return start
    .clone()
    .multiplyScalar(oneMinus * oneMinus)
    .add(control.clone().multiplyScalar(2 * oneMinus * t))
    .add(end.clone().multiplyScalar(t * t));
}

function clearControl(
  start: THREE.Vector3,
  end: THREE.Vector3,
  extraHeight = 0.36,
  lateralBias = 0,
  pathContext?: StrokePathContext,
): THREE.Vector3 {
  const distance = start.distanceTo(end);
  const control = new THREE.Vector3(
    (start.x + end.x) * 0.5,
    Math.max(start.y, end.y) + Math.min(0.90, extraHeight + distance * 0.15),
    Math.min(start.z, end.z) - Math.min(0.32, 0.11 + distance * 0.08),
  );
  control.x += lateralBias;
  if (pathContext?.routeObstacle) {
    if (pathContext.routeObstacle.id === 'drums.crash.dish') {
      const [centerX, , centerZ] = pathContext.routeObstacle.center;
      // The rest tip begins below the crash. Move well outside its rear-left
      // footprint before rising; a high arc alone can still carry the shaft
      // through the dish underside. Scale the authored offsets from the
      // measured radius so the route follows the cymbal if its size changes.
      const xClearance = pathContext.stickId === 'left' ? 2.58 : 3.2;
      const yClearance = pathContext.stickId === 'left' ? 2.55 : 2.14;
      control.set(
        Math.min(
          start.x,
          end.x,
          centerX - pathContext.routeObstacle.radius * xClearance,
        ),
        Math.max(start.y, end.y, pathContext.routeObstacle.maxY) +
          pathContext.routeObstacle.radius * yClearance,
        Math.min(start.z, end.z, centerZ - pathContext.routeObstacle.radius) -
          pathContext.routeObstacle.radius * 0.65,
      );
      return control;
    }
    // The left floor-tom to player-rest passage crosses under the rack tom.
    // The control height is authored below the real shell's lower envelope,
    // including the measured stick radius, so the entire shaft clears while
    // the tip still follows the same exact endpoints.
    control.y = Math.min(
      control.y,
      pathContext.routeObstacle.minY -
        pathContext.routeObstacle.clearance -
        CLEARANCE_MARGIN,
    );
  }
  return control;
}

function handEvents(
  notes: readonly NoteEvent[],
  stickId: 'left' | 'right',
  anchors: Map<string, THREE.Vector3>,
): NoteEvent[] {
  return notes
    .filter(
      (note) =>
        note.instrumentId === 'drums' &&
        note.stickId === stickId &&
        note.drumPart !== 'kick' &&
        anchors.has(note.componentId),
    )
    .slice()
    .sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.id.localeCompare(b.id));
}

function positiveFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > EPSILON
    ? value
    : fallback;
}

interface StrokePathContext {
  readonly root: THREE.Group;
  readonly restTip: THREE.Vector3;
  readonly stickId: 'left' | 'right';
  readonly tipLength: number;
  readonly obstacles: readonly DrumMotionObstacle[];
  /** Authored route around one known shell for a dense hand transition. */
  readonly routeObstacle?: DrumMotionObstacle;
}

/**
 * Resolve a player-side wrist direction without adding a visible hand.
 * The virtual fulcrum follows a target laterally, but remains above and
 * behind it, so the stick reads as held from the stool side of the kit.
 */
export function playerGripDirection(
  tip: THREE.Vector3,
  restTip: THREE.Vector3,
  stickId: 'left' | 'right',
): THREE.Vector3 {
  const lateralSign = stickId === 'left' ? -1 : 1;
  const tipDeltaX = tip.x - restTip.x;
  const fulcrum = new THREE.Vector3(
    restTip.x + lateralSign * GRIP_LATERAL_OFFSET + tipDeltaX * GRIP_FOLLOW,
    tip.y + GRIP_VERTICAL_OFFSET,
    tip.z - GRIP_PLAYER_SIDE_OFFSET,
  );
  const direction = new THREE.Vector3().subVectors(tip, fulcrum);
  const lengthSq = direction.lengthSq();
  if (!Number.isFinite(lengthSq) || lengthSq <= EPSILON * EPSILON) {
    // Malformed/degenerate input must never pass a zero vector to a
    // quaternion. Keep the fallback in the same player-side half-space.
    return new THREE.Vector3(-lateralSign * 0.30, -0.34, 0.62).normalize();
  }
  return direction.multiplyScalar(1 / Math.sqrt(lengthSq));
}

function motionObstacles(root: THREE.Group): readonly DrumMotionObstacle[] {
  const value = root.userData.drumMotionObstacles as
    | readonly DrumMotionObstacle[]
    | undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((obstacle) => {
    if (!obstacle || typeof obstacle.id !== 'string') return false;
    const values = [
      ...obstacle.center,
      obstacle.radius,
      obstacle.minY,
      obstacle.maxY,
      obstacle.clearance,
    ];
    return values.every(Number.isFinite) &&
      obstacle.radius > EPSILON &&
      obstacle.maxY > obstacle.minY &&
      obstacle.clearance > EPSILON;
  });
}

function motionRouteForSegment(
  start: THREE.Vector3,
  end: THREE.Vector3,
  obstacles: readonly DrumMotionObstacle[],
  targetComponentId?: string,
): DrumMotionObstacle | undefined {
  // This is a cheap authored envelope test, evaluated from segment endpoints
  // only.  The shaft reaches roughly 0.4 m behind/above a tip; expanding the
  // horizontal and vertical endpoint ranges by that reach catches a path
  // whose tip clears the rack tom while its shaft would enter the shell.
  const xReach = DEFAULT_TIP_LENGTH * 0.45;
  const yReach = DEFAULT_TIP_LENGTH * 0.45;
  const zReach = DEFAULT_TIP_LENGTH + 0.04;
  const xMin = Math.min(start.x, end.x) - xReach;
  const xMax = Math.max(start.x, end.x) + xReach;
  const yMin = Math.min(start.y, end.y);
  const yMax = Math.max(start.y, end.y) + yReach;
  const zMin = Math.min(start.z, end.z) - zReach;
  const zMax = Math.max(start.z, end.z) + 0.04;

  const routeId = targetComponentId === 'drums.crash'
    ? 'drums.crash.dish'
    : 'drums.tom.shell';
  return obstacles.find((obstacle) => {
    if (obstacle.id !== routeId) return false;
    const [centerX, , centerZ] = obstacle.center;
    // A target just above this shell already has a measured tangent shaft
    // corridor. Keep the normal high arc for that approach; the under-shell
    // route is only needed when both endpoints live below the tom's top.
    if (Math.max(start.y, end.y) > obstacle.maxY + obstacle.clearance) {
      return false;
    }
    const verticalOverlap =
      yMax >= obstacle.minY - obstacle.clearance ||
      // The ordinary quadratic control can rise by up to 0.90 m. Include
      // that authored lift when deciding whether a direct dense stroke needs
      // the under-shell route; endpoint-only checks miss floor-tom to snare.
      (obstacle.id === 'drums.tom.shell' &&
        yMax + 0.90 >= obstacle.minY - obstacle.clearance);
    return (
      centerX >= xMin - obstacle.radius &&
      centerX <= xMax + obstacle.radius &&
      centerZ >= zMin - obstacle.radius &&
      centerZ <= zMax + obstacle.radius &&
      verticalOverlap &&
      yMin <= obstacle.maxY + obstacle.clearance
    );
  });
}

function targetNormalInRoot(
  root: THREE.Group,
  obstacle: DrumMotionObstacle,
): THREE.Vector3 {
  const localNormal = obstacle.normalLocal;
  if (!localNormal) return new THREE.Vector3(0.35, 0.94, 0).normalize();
  const cymbals = root.userData.cymbals as
    | Map<string, THREE.Object3D>
    | undefined;
  const target = cymbals?.get('drums.crash');
  const rotation = target?.rotation.z ?? -0.10;
  return new THREE.Vector3(...localNormal)
    .applyAxisAngle(new THREE.Vector3(0, 0, 1), rotation)
    .normalize();
}

function crashPreparationTip(
  start: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
  lateralBias: number,
  pathContext: StrokePathContext,
  strokeDuration = PREPARATION_SECONDS,
): THREE.Vector3 {
  const routeObstacle = pathContext.routeObstacle;
  if (!routeObstacle || routeObstacle.id !== 'drums.crash.dish') {
    return quadraticBezier(
      start,
      clearControl(start, end, 0.62, lateralBias, pathContext),
      end,
      smoothStep(progress),
    );
  }

  const [centerX, , centerZ] = routeObstacle.center;
  const horizontalStartDistance = Math.hypot(
    start.x - centerX,
    start.z - centerZ,
  );
  if (horizontalStartDistance > routeObstacle.radius + 0.12) {
    // A target such as the rack tom already starts outside the dish's rim.
    // It can use a short raised arc to the normal staging point; the large
    // rear-left route is reserved for a player rest pose inside the dish
    // footprint.
    const staging = end.clone().addScaledVector(
      targetNormalInRoot(pathContext.root, routeObstacle),
      CRASH_STAGING_DISTANCE,
    );
    const routeProgress = clamp01(progress);
    if (routeProgress < CRASH_PREPARATION_SPLIT) {
      return compactTransitionTip(
        start,
        staging,
        routeProgress / CRASH_PREPARATION_SPLIT,
        strokeDuration * CRASH_PREPARATION_SPLIT,
        lateralBias,
        { ...pathContext, routeObstacle: undefined },
      );
    }
    return staging.lerp(
      end,
      tangentApproach(
        (routeProgress - CRASH_PREPARATION_SPLIT) /
          (1 - CRASH_PREPARATION_SPLIT),
      ),
    );
  }

  // Leave the high lateral arc at a measured offset above the current dish,
  // then descend along its current upper-surface normal. This keeps the tip
  // and the player-side shaft outside the swaying mesh until exact contact.
  const staging = end.clone().addScaledVector(
    targetNormalInRoot(pathContext.root, routeObstacle),
    CRASH_STAGING_DISTANCE,
  );
  const routeProgress = clamp01(progress);
  if (routeProgress < CRASH_PREPARATION_SPLIT) {
    return quadraticBezier(
      start,
      clearControl(start, end, 0.62, lateralBias, pathContext),
      staging,
      smoothStep(routeProgress / CRASH_PREPARATION_SPLIT),
    );
  }
  return staging.lerp(
    end,
    tangentApproach(
      (routeProgress - CRASH_PREPARATION_SPLIT) /
        (1 - CRASH_PREPARATION_SPLIT),
    ),
  );
}

function compactTransitionTip(
  start: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
  gap: number,
  lateralBias: number,
  pathContext: StrokePathContext,
): THREE.Vector3 {
  // Scale the lift with the available beat window. The hardware-specific
  // branches in clearControl still take precedence when a rendered shell or
  // cymbal occupies the direct segment.
  const gapScale = clamp01(gap / COMPACT_TRANSITION_MAX_GAP);
  return quadraticBezier(
    start,
    clearControl(
      start,
      end,
      0.18 + gapScale * 0.24,
      lateralBias,
      pathContext,
    ),
    end,
    smoothStep(progress),
  );
}

function crashDepartureTip(
  start: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
  gap: number,
  lateralBias: number,
  pathContext: StrokePathContext,
): THREE.Vector3 {
  const staging = start.clone().addScaledVector(
    targetNormalInRoot(pathContext.root, pathContext.routeObstacle!),
    CRASH_STAGING_DISTANCE,
  );
  const routeProgress = clamp01(progress);
  if (routeProgress < CRASH_EXIT_SPLIT) {
    return start.clone().lerp(
      staging,
      smoothStep(routeProgress / CRASH_EXIT_SPLIT),
    );
  }
  // Once the shaft has cleared the dish along its current normal, use the
  // short direct arc to the next surface without reusing the large crash
  // avoidance control point.
  return compactTransitionTip(
    staging,
    end,
    (routeProgress - CRASH_EXIT_SPLIT) / (1 - CRASH_EXIT_SPLIT),
    gap * (1 - CRASH_EXIT_SPLIT),
    lateralBias,
    { ...pathContext, routeObstacle: undefined },
  );
}

function crashCompactTransitionTip(
  start: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
  pathContext: StrokePathContext,
): THREE.Vector3 {
  const normal = targetNormalInRoot(
    pathContext.root,
    pathContext.routeObstacle!,
  );
  // A repeated crash pair can stay above the same rendered dish. This short
  // normal lift avoids the large rest-to-crash detour while preserving a
  // tangent shaft corridor at both contacts.
  const stagingStart = start.clone().addScaledVector(
    normal,
    CRASH_STAGING_DISTANCE,
  );
  const stagingEnd = end.clone().addScaledVector(
    normal,
    CRASH_STAGING_DISTANCE,
  );
  const routeProgress = clamp01(progress);
  if (routeProgress < 0.5) {
    return start.clone().lerp(
      stagingStart,
      smoothStep(routeProgress * 2),
    );
  }
  return stagingStart.clone().lerp(
    stagingEnd,
    tangentApproach((routeProgress - 0.5) * 2),
  ).lerp(
    end,
    tangentApproach((routeProgress - 0.5) * 2),
  );
}

function eventAnchor(
  event: NoteEvent,
  anchors: Map<string, THREE.Vector3>,
): THREE.Vector3 | undefined {
  const anchor = anchors.get(event.componentId);
  if (!anchor || !anchor.toArray().every(Number.isFinite)) return undefined;
  return anchor;
}

function eventIndexAtOrBefore(
  time: number,
  events: readonly NoteEvent[],
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.onsetSeconds <= time + EPSILON) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function preparationDuration(gap: number): number {
  // Dense rolls still get an eased approach, while this cap leaves a small
  // physical interval after the previous contact for the wrist to rebound.
  return Math.min(PREPARATION_SECONDS, Math.max(0, gap) * 0.44);
}

function tipAfterPrevious(
  time: number,
  previousOnset: number,
  previousAnchor: THREE.Vector3,
  nextPreparationStart: number,
  restTip: THREE.Vector3,
  lateralBias: number,
  pathContext: StrokePathContext,
): THREE.Vector3 {
  const reboundDuration = Math.min(
    REBOUND_SECONDS,
    Math.max(nextPreparationStart - previousOnset, EPSILON),
  );
  if (time <= previousOnset + reboundDuration) {
    const progress = (time - previousOnset) / reboundDuration;
    if (pathContext.routeObstacle?.id === 'drums.crash.dish') {
      return crashDepartureTip(
        previousAnchor,
        restTip,
        progress,
        reboundDuration,
        lateralBias,
        pathContext,
      );
    }
    return quadraticBezier(
      previousAnchor,
      clearControl(previousAnchor, restTip, 0.86, lateralBias, pathContext),
      restTip,
      smoothStep((time - previousOnset) / reboundDuration),
    );
  }
  return restTip.clone();
}

function kickEvents(notes: readonly NoteEvent[]): NoteEvent[] {
  return notes
    .filter(
      (note) =>
        note.instrumentId === 'drums' &&
        note.drumPart === 'kick' &&
        note.stickId === 'pedal',
    )
    .slice()
    .sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.id.localeCompare(b.id));
}

function tipAtTime(
  timeSeconds: number,
  events: readonly NoteEvent[],
  anchors: Map<string, THREE.Vector3>,
  restTip: THREE.Vector3,
  lateralBias: number,
  stickId: 'left' | 'right',
  tipLength: number,
  obstacles: readonly DrumMotionObstacle[],
  root: THREE.Group,
): THREE.Vector3 {
  if (!events.length) return restTip.clone();
  const time = finiteTime(timeSeconds);
  const first = events[0];
  const firstAnchor = eventAnchor(first, anchors);
  if (!firstAnchor) return restTip.clone();

  const basePathContext: StrokePathContext = {
    root,
    restTip,
    stickId,
    tipLength,
    obstacles,
    routeObstacle: motionRouteForSegment(
      restTip,
      firstAnchor,
      obstacles,
      first.componentId,
    ),
  };
  // The first crash stroke starts from the player's rest pose inside the
  // cymbal footprint and therefore has a longer available approach window.
  // Use it to reduce velocity while keeping the exact onset contact time.
  const firstPreparationDuration =
    basePathContext.routeObstacle?.id === 'drums.crash.dish'
      ? CRASH_INITIAL_PREPARATION_SECONDS
      : PREPARATION_SECONDS;
  const firstPreparationStart =
    first.onsetSeconds - firstPreparationDuration;
  if (time < firstPreparationStart) return restTip.clone();

  if (time < first.onsetSeconds) {
    return quadraticBezier(
      restTip,
      clearControl(restTip, firstAnchor, 0.60, lateralBias, basePathContext),
      firstAnchor,
      smoothStep((time - firstPreparationStart) / firstPreparationDuration),
    );
  }

  const previousIndex = eventIndexAtOrBefore(time, events);
  if (previousIndex < 0) return restTip.clone();

  const previous = events[previousIndex];
  const previousAnchor = eventAnchor(previous, anchors);
  if (!previousAnchor) return restTip.clone();
  const next = events[previousIndex + 1];
  const nextAnchor = next && eventAnchor(next, anchors);
  const reboundPathContext: StrokePathContext = {
    ...basePathContext,
    routeObstacle: motionRouteForSegment(
      previousAnchor,
      restTip,
      obstacles,
      previous.componentId,
    ),
  };

  if (next && nextAnchor) {
    const gap = Math.max(next.onsetSeconds - previous.onsetSeconds, 0);
    if (gap <= COMPACT_TRANSITION_MAX_GAP && gap > EPSILON) {
      // Dense passages do not have enough musical time for a complete
      // rebound to rest followed by another long preparation arc. Carry the
      // stick directly between the two authored contact anchors instead.
      // Prefer the previous crash as the route obstacle while leaving it, so
      // a crash-to-non-crash transition also clears the rendered dish.
      const routeComponentId = previous.componentId === 'drums.crash'
        ? previous.componentId
        : next.componentId;
      const compactPathContext: StrokePathContext = {
        ...basePathContext,
        routeObstacle: motionRouteForSegment(
          previousAnchor,
          nextAnchor,
          obstacles,
          routeComponentId,
        ),
      };
      if (time < next.onsetSeconds) {
        if (compactPathContext.routeObstacle?.id === 'drums.crash.dish') {
          const progress = (time - previous.onsetSeconds) / gap;
          if (
            previous.componentId === 'drums.crash' &&
            next.componentId === 'drums.crash'
          ) {
            return crashCompactTransitionTip(
              previousAnchor,
              nextAnchor,
              progress,
              compactPathContext,
            );
          }
          return previous.componentId === 'drums.crash'
            ? crashDepartureTip(
                previousAnchor,
                nextAnchor,
                progress,
                gap,
                lateralBias,
                compactPathContext,
              )
              : crashPreparationTip(
                  previousAnchor,
                  nextAnchor,
                  progress,
                  lateralBias,
                  compactPathContext,
                  gap,
                );
        }
        return compactTransitionTip(
          previousAnchor,
          nextAnchor,
          (time - previous.onsetSeconds) / gap,
          gap,
          lateralBias,
          compactPathContext,
        );
      }
      // Exact onset contact is the anchor itself. Equal-timestamp events on
      // a single stick cannot both occupy one physical tip, so the stable
      // sort deterministically gives the later event the contact pose.
      if (time <= next.onsetSeconds + EPSILON) return nextAnchor.clone();
    }
    const preparation = preparationDuration(gap);
    const preparationStart = next.onsetSeconds - preparation;
    if (time < preparationStart) {
      return tipAfterPrevious(
        time,
        previous.onsetSeconds,
        previousAnchor,
        preparationStart,
        restTip,
        lateralBias,
        reboundPathContext,
      );
    }
    if (time < next.onsetSeconds && preparation > EPSILON) {
      const reboundTip = tipAfterPrevious(
        preparationStart,
        previous.onsetSeconds,
        previousAnchor,
        preparationStart,
        restTip,
        lateralBias,
        reboundPathContext,
      );
      const preparationPathContext: StrokePathContext = {
        ...basePathContext,
        routeObstacle: motionRouteForSegment(
          reboundTip,
          nextAnchor,
          obstacles,
          next.componentId,
        ),
      };
      return crashPreparationTip(
        reboundTip,
        nextAnchor,
        (time - preparationStart) / preparation,
        lateralBias,
        preparationPathContext,
        preparation,
      );
    }
    // Exact onset contact is the anchor itself. Equal-timestamp events on a
    // single stick cannot both occupy one physical tip, so the stable sort
    // deterministically gives the later event the contact pose.
    if (time <= next.onsetSeconds + EPSILON) return nextAnchor.clone();
  }

  const reboundDuration =
    reboundPathContext.routeObstacle?.id === 'drums.crash.dish'
      ? CRASH_REBOUND_SECONDS
      : REBOUND_SECONDS;
  const reboundProgress =
    (time - previous.onsetSeconds) / reboundDuration;
  if (reboundPathContext.routeObstacle?.id === 'drums.crash.dish') {
    return crashDepartureTip(
      previousAnchor,
      restTip,
      reboundProgress,
      reboundDuration,
      lateralBias,
      reboundPathContext,
    );
  }
  const rebound = smoothStep(reboundProgress);
  return quadraticBezier(
    previousAnchor,
    clearControl(
      previousAnchor,
      restTip,
      0.34,
      lateralBias,
      reboundPathContext,
    ),
    restTip,
    rebound,
  );
}

function setStickPose(
  stick: THREE.Group,
  tip: THREE.Vector3,
  restTip: THREE.Vector3,
  stickId: 'left' | 'right',
): void {
  const tipLength = positiveFinite(stick.userData.tipLength, DEFAULT_TIP_LENGTH);
  const direction = playerGripDirection(tip, restTip, stickId);
  stick.quaternion.setFromUnitVectors(AXIS_Z, direction);
  // The group origin is the invisible grip end. Using the same measured
  // length on every frame keeps the visible shaft rigid.
  stick.position.copy(tip).addScaledVector(direction, -tipLength);
  stick.userData.fixedShaftLength = tipLength;
  stick.userData.playerGrip = stick.position.toArray();
  stick.userData.playerGripDirection = direction.toArray();
  stick.userData.mechanicsTip = tip.toArray();
}

function kickStrength(
  timeSeconds: number,
  events: readonly NoteEvent[],
): number {
  if (!events.length) return 0;
  const time = finiteTime(timeSeconds);
  let previous: NoteEvent | undefined;
  let next: NoteEvent | undefined;
  for (const event of events) {
    if (event.onsetSeconds <= time + EPSILON) previous = event;
    else {
      next = event;
      break;
    }
  }
  let strength = 0;
  if (next && time < next.onsetSeconds) {
    strength = smoothStep(
      (time - (next.onsetSeconds - PREPARATION_SECONDS)) /
        PREPARATION_SECONDS,
    );
  }
  if (previous) {
    strength = Math.max(
      strength,
      1 - smoothStep((time - previous.onsetSeconds) / REBOUND_SECONDS),
    );
  }
  return clamp01(strength);
}

/**
 * Apply an absolute-time drum pose to the authored kit.
 *
 * Hand paths use a raised quadratic clearance arc between each pair of real
 * surface anchors. The explicit arc keeps the shaft above the rack, stands,
 * and cymbal hardware while the tip remains exactly on its assigned target at
 * each onset. Kick motion uses the model's rear batter-head contact metadata.
 */
export function applyDrumMechanics(
  host: DrumMechanicsHost,
  timeSeconds: number,
  notes: readonly NoteEvent[],
  reducedMotion = false,
  kickContact: KickBeaterContact = {
    restRotationX: -0.4,
    contactRotationX: 0.14,
  },
): void {
  const rests = host.root.userData.mechanicsRestTips as
    | Record<'left' | 'right', [number, number, number]>
    | undefined;
  const defaultRests: Record<'left' | 'right', THREE.Vector3> = {
    left: new THREE.Vector3(-1.12, 1.42, -0.34),
    right: new THREE.Vector3(-0.78, 1.42, -0.34),
  };
  const obstacles = motionObstacles(host.root);

  for (const stickId of ['left', 'right'] as const) {
    const stick = host.sticks.get(stickId);
    if (!stick) continue;
    const rest = rests?.[stickId]
      ? new THREE.Vector3(...rests[stickId])
      : defaultRests[stickId];
    const tip = reducedMotion
      ? rest
      : tipAtTime(
          timeSeconds,
          handEvents(notes, stickId, host.hitAnchors),
          host.hitAnchors,
          rest,
          stickId === 'left' ? -0.28 : 0.28,
          stickId,
          positiveFinite(stick.userData.tipLength, DEFAULT_TIP_LENGTH),
          obstacles,
          host.root,
        );
    setStickPose(stick, tip, rest, stickId);
  }

  const beater = host.kickBeater;
  const strength = reducedMotion
    ? 0
    : kickStrength(timeSeconds, kickEvents(notes));
  beater.rotation.x =
    kickContact.restRotationX +
    (kickContact.contactRotationX - kickContact.restRotationX) * strength;
}
