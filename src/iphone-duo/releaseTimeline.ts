import * as THREE from 'three';

export type IphoneDuoReleaseSequence = 'display' | 'hinge';

export interface IphoneDuoReleaseCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  rootRotation: [number, number, number];
}

export interface IphoneDuoReleaseLighting {
  keyIntensity: number;
  fillIntensity: number;
  rimIntensity: number;
  sweep: number;
}

export interface IphoneDuoReleaseFrame {
  sequence: IphoneDuoReleaseSequence;
  time: number;
  duration: number;
  progress: number;
  fold: number;
  displayBlur: number;
  coverBlur: number;
  camera: IphoneDuoReleaseCameraPose;
  lighting: IphoneDuoReleaseLighting;
}

export const IPHONE_DUO_RELEASE_DURATIONS: Record<IphoneDuoReleaseSequence, number> = {
  display: 3,
  hinge: 3.133,
};

const DISPLAY_POSITION: [number, number, number] = [0, 1.28, 8];
const DISPLAY_TARGET: [number, number, number] = [0, 1.28, 0];
export const IPHONE_DUO_HINGE_CUT = 43 / 30;

const HINGE_POSITION: [number, number, number] = [0, 1.28, 7.2];

const clamp = (value: number, minimum: number, maximum: number): number =>
  THREE.MathUtils.clamp(Number.isFinite(value) ? value : minimum, minimum, maximum);

const smoothStep = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

type MotionKnot = readonly [time: number, value: number];

/**
 * Builds monotone cubic tangents for the measured motion knots. Unlike a smoothStep at every
 * landmark, this keeps a continuous velocity through the handoff, V and settling phases while
 * preventing overshoot beyond the observed opening angles.
 */
const monotoneTangents = (knots: readonly MotionKnot[]): number[] => {
  if (knots.length < 2) return knots.map(() => 0);
  const secants = knots.slice(0, -1).map((knot, index) => {
    const next = knots[index + 1];
    return (next[1] - knot[1]) / Math.max(Number.EPSILON, next[0] - knot[0]);
  });
  const tangents = new Array<number>(knots.length).fill(0);
  tangents[0] = secants[0];
  tangents[tangents.length - 1] = secants[secants.length - 1];
  for (let index = 1; index < knots.length - 1; index += 1) {
    const previous = secants[index - 1];
    const next = secants[index];
    tangents[index] = previous === 0 || next === 0 || previous * next < 0
      ? 0
      : (previous + next) / 2;
  }
  // Fritsch–Carlson's interval limiter preserves monotonicity after the averaged tangents.
  secants.forEach((secant, index) => {
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      return;
    }
    const alpha = tangents[index] / secant;
    const beta = tangents[index + 1] / secant;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const limiter = 3 / Math.sqrt(magnitude);
      tangents[index] = limiter * alpha * secant;
      tangents[index + 1] = limiter * beta * secant;
    }
  });
  return tangents;
};

const sampleMonotone = (knots: readonly MotionKnot[], tangents: readonly number[], time: number): number => {
  if (time <= knots[0][0]) return knots[0][1];
  if (time >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
  let index = 0;
  while (index < knots.length - 2 && time > knots[index + 1][0]) index += 1;
  const [fromTime, fromValue] = knots[index];
  const [toTime, toValue] = knots[index + 1];
  const span = toTime - fromTime;
  const t = clamp((time - fromTime) / Math.max(Number.EPSILON, span), 0, 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * fromValue + h10 * span * tangents[index]
    + h01 * toValue + h11 * span * tangents[index + 1];
};

// Runtime hinge and yaw fit to the supplied film silhouettes. These are reconstructed
// parameters, not recovered manufacturer angles. The source begins moving before .75 s.
const DISPLAY_FOLD_KNOTS: readonly MotionKnot[] = [
  [0, 0],
  [0.1, 0],
  [0.366667, 2],
  [0.6, 7],
  [0.866667, 18],
  [1.1, 35],
  [1.36667, 60],
  [1.6, 90],
  [1.66667, 104.467],
  [1.73333, 119.654],
  [1.8, 131.806],
  [1.86667, 138],
  [2.1, 153],
  [2.36667, 169],
  [2.6, 180],
  [3, 180],
];
const DISPLAY_FOLD_TANGENTS = monotoneTangents(DISPLAY_FOLD_KNOTS);
const DISPLAY_YAW_KNOTS: readonly MotionKnot[] = [
  [0, 0],
  [0.1, 0],
  [0.866667, 0],
  [1.36667, 7],
  [1.6, 12],
  [1.86667, 8],
  [2.1, 3],
  [2.36667, 0],
  [3, 0],
];
const DISPLAY_YAW_TANGENTS = monotoneTangents(DISPLAY_YAW_KNOTS);

// Camera framing fitted to source silhouettes, using verified source frame indices.
// The earlier 4 fps extraction selected bin-center frames (3,11,18,...), not 0,.25,.5 seconds.
const DISPLAY_ZOOM_KNOTS: readonly MotionKnot[] = [
  [0, 0.949451],
  [0.1, 0.949451],
  [0.366667, 0.951754],
  [0.6, 0.958425],
  [0.866667, 0.96087],
  [1.1, 0.965517],
  [1.36667, 0.972458],
  [1.6, 0.985386],
  [1.66667, 0.986956],
  [1.73333, 0.985527],
  [1.8, 0.981312],
  [1.86667, 0.978723],
  [2.1, 0.965293],
  [2.36667, 0.949672],
  [2.6, 0.934211],
  [2.86667, 0.932018],
  [3, 0.932018],
];
const DISPLAY_ZOOM_TANGENTS = monotoneTangents(DISPLAY_ZOOM_KNOTS);
const DISPLAY_X_KNOTS: readonly MotionKnot[] = [
  [0, 0.020478],
  [0.1, 0.020478],
  [0.366667, 0.033177],
  [0.6, 0.00952],
  [0.866667, -0.040946],
  [1.1, -0.108193],
  [1.36667, -0.211436],
  [1.6, -0.401047],
  [1.66667, -0.482543],
  [1.73333, -0.30508],
  [1.8, -0.174596],
  [1.86667, -0.118713],
  [2.1, -0.012132],
  [2.36667, 0.027702],
  [2.6, 0.017721],
  [2.86667, 0.014264],
  [3, 0.014264],
];
const DISPLAY_X_TANGENTS = monotoneTangents(DISPLAY_X_KNOTS);
const DISPLAY_Y_KNOTS: readonly MotionKnot[] = [
  [0, 1.62799],
  [0.1, 1.62799],
  [0.366667, 1.62386],
  [0.6, 1.62467],
  [0.866667, 1.62051],
  [1.1, 1.61882],
  [1.36667, 1.62623],
  [1.6, 1.61506],
  [1.66667, 1.59128],
  [1.73333, 1.59761],
  [1.8, 1.6008],
  [1.86667, 1.61411],
  [2.1, 1.62555],
  [2.36667, 1.63444],
  [2.6, 1.64357],
  [2.86667, 1.64091],
  [3, 1.64091],
];
const DISPLAY_Y_TANGENTS = monotoneTangents(DISPLAY_Y_KNOTS);


// Projected V angles measured from the straight outer rail, not estimated from contact sheets.
const HINGE_FOLD_KNOTS: readonly MotionKnot[] = [
  [0 / 30, 79.628859],
  [5 / 30, 87.821804],
  [10 / 30, 96.339528],
  [15 / 30, 105.140528],
  [20 / 30, 114.287560],
  [25 / 30, 123.874667],
  [30 / 30, 133.892799],
  [35 / 30, 144.552328],
  [38 / 30, 151.246872],
  [40 / 30, 156.050165],
  [41 / 30, 158.214341],
  [43 / 30, 163.1],
];
const HINGE_FOLD_TANGENTS = monotoneTangents(HINGE_FOLD_KNOTS);

/**
 * Samples the observed Apple release timing. The values describe the visible product gesture,
 * rather than pretending the supplied films contain an exportable animation track. The opening
 * angle is an image-space proxy: the source reaches near-perpendicular around 1.6 s, broad V
 * around 1.87 s, and continues its subtle opening/settling through 2.6 s.
 */
export function sampleIphoneDuoRelease(sequence: IphoneDuoReleaseSequence, rawTime: number): IphoneDuoReleaseFrame {
  const duration = IPHONE_DUO_RELEASE_DURATIONS[sequence];
  const time = clamp(rawTime, 0, duration);
  const progress = duration > 0 ? time / duration : 0;

  if (sequence === 'hinge') {
    // The pre-cut macro remains in the audited V band. Film 09 then cuts to the flat profile
    // pose at frame 43 (1.433 s) instead of implying a continuous opening animation through that edit.
    const fold = time < IPHONE_DUO_HINGE_CUT
      ? sampleMonotone(HINGE_FOLD_KNOTS, HINGE_FOLD_TANGENTS, time)
      : 180;
    // Film 09 is an editorial cut at frame 43 (1.433 s), so the macro camera does not travel into
    // the side-profile shot. The exact cut is represented as a deterministic step.
    const zoom = time < IPHONE_DUO_HINGE_CUT ? 6.4 : 1.55;
    const sweep = 0.5 + 0.5 * Math.sin((time / duration) * Math.PI * 2.2 - 0.65);
    return {
      sequence,
      time,
      duration,
      progress,
      fold,
      displayBlur: 0,
      coverBlur: 0,
      camera: {
        position: time < IPHONE_DUO_HINGE_CUT ? HINGE_POSITION : [0, 1.11, 7.2],
        // The close macro is anchored around the hinge tip; the side-profile shot returns to
        // the stage center after the editorial cut.
        target: [0, time < IPHONE_DUO_HINGE_CUT ? 0.6 : 1.11, 0],
        zoom,
        // The close-up source presents the hinge on its horizontal axis and shows the camera leaf
        // on the left. This root pose keeps the imported vertical phone axis from reading as a
        // full product spin while matching that handedness.
        rootRotation: [-Math.PI / 2, THREE.MathUtils.degToRad((180 - fold) / 2), Math.PI],
      },
      lighting: {
        keyIntensity: 0.9,
        fillIntensity: 2.4,
        rimIntensity: 0.14 + sweep * 0.11,
        sweep,
      },
    };
  }

  const cameraX = sampleMonotone(DISPLAY_X_KNOTS, DISPLAY_X_TANGENTS, time);
  const cameraY = sampleMonotone(DISPLAY_Y_KNOTS, DISPLAY_Y_TANGENTS, time);
  const resolvedFold = sampleMonotone(DISPLAY_FOLD_KNOTS, DISPLAY_FOLD_TANGENTS, time);
  const displayBlur = 1 - smoothStep((time - 1.866667) / 1.0);
  // Film 01 keeps the studio source fixed: changing leaf normals create the traveling
  // reflection. Do not add an unrelated oscillating light over the settled display.
  const sweep = 0.5;

  return {
    sequence,
    time,
    duration,
    progress,
    fold: resolvedFold,
    displayBlur,
    coverBlur: smoothStep(time / 0.1),
    camera: {
      position: [cameraX, cameraY, DISPLAY_POSITION[2]],
      target: [cameraX, cameraY, DISPLAY_TARGET[2]],
      zoom: sampleMonotone(DISPLAY_ZOOM_KNOTS, DISPLAY_ZOOM_TANGENTS, time),
      rootRotation: [0, THREE.MathUtils.degToRad(sampleMonotone(DISPLAY_YAW_KNOTS, DISPLAY_YAW_TANGENTS, time)), 0],
    },
    lighting: {
      keyIntensity: 0.9,
      fillIntensity: 2.4,
      rimIntensity: 0.1 + sweep * 0.08,
      sweep,
    },
  };
}
