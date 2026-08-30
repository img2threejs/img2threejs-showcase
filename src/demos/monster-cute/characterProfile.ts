/**
 * What the character is, read from its own data.
 *
 * Every colour here was sampled from the vertex colours embedded in `surfaceData.high.ts`, every
 * socket position from the vertices the rig's skin weights bind to a named bone, and every clip
 * descriptor from seeking the clip and measuring where the joints went. The JSON is imported
 * rather than transcribed so this module cannot drift from the measurement that produced it —
 * re-run `npm run measure` and `npm run gate:r1` and the constants below change with it.
 *
 * Nothing in this file is a colour picked by eye or a coordinate typed by hand.
 */
import * as THREE from 'three';
import paletteEvidence from './evidence/palette.json';
import socketEvidence from './evidence/sockets.json';
import gateEvidence from './evidence/gate-r1.json';

/** Figure height in world units. Every size in the VFX layer is a fraction of this. */
export const FIGURE_HEIGHT = 1.9;

// ---------------------------------------------------------------- palette

const regionHex = (id: string, fallback: string): string =>
  paletteEvidence.regions.find((r) => r.id === id)?.hex ?? fallback;

const clusterHex = (rank: number, fallback: string): string =>
  paletteEvidence.dominantClusters[rank]?.hex ?? fallback;

/**
 * Shift a measured colour in HSL rather than replacing it.
 *
 * An effect needs colours the surface does not literally contain — a glow core is brighter than
 * any fur vertex, an impact accent is more saturated than any of them. Deriving those by moving
 * the measured colour keeps the whole effect palette inside the character's own hue family, which
 * is the difference between lighting that belongs to this monster and lighting that belongs to a
 * stock demo.
 */
function shift(hex: string, dh: number, ds: number, dl: number): THREE.Color {
  const c = new THREE.Color(hex);
  const h = { h: 0, s: 0, l: 0 };
  c.getHSL(h);
  return new THREE.Color().setHSL(
    (h.h + dh / 360 + 1) % 1,
    THREE.MathUtils.clamp(h.s + ds, 0, 1),
    THREE.MathUtils.clamp(h.l + dl, 0, 1),
  );
}

/** The six colours the measurement found on the figure, plus the accents derived from them. */
export const PALETTE = {
  /** #4487a4 — 88% of the surface. The fur. */
  fur: new THREE.Color(regionHex('fur', '#4487a4')),
  /** #236a8b — the shaded fur cluster. */
  furDeep: new THREE.Color(clusterHex(2, '#236a8b')),
  /** #5a9bb5 — the lit fur cluster. */
  furLight: new THREE.Color(clusterHex(1, '#5a9bb5')),
  /** #80a8ba — the pale front patch. */
  belly: new THREE.Color(regionHex('belly', '#80a8ba')),
  /** #728592 — the horns. */
  horn: new THREE.Color(regionHex('horn', '#728592')),
  /** #d7d3ce — eye whites and fangs. */
  sclera: new THREE.Color(regionHex('sclera', '#d7d3ce')),
  /** #081116 — the irises. */
  iris: new THREE.Color(regionHex('iris', '#081116')),
  /** #32314d — the wristbands, the only non-blue thing the monster wears. */
  band: new THREE.Color(regionHex('wristband', '#32314d')),
} as const;

/**
 * Effect accents, each derived from a measured colour by a stated HSL move.
 *
 * `impact` is the one worth explaining: nothing on this character is red, so a red hit flash would
 * be a colour from outside the subject. The wristbands are the monster's own secondary hue — the
 * single violet note in an otherwise cyan figure — so the impact accent is that violet lifted into
 * a range that reads at speed, rather than a red imported from somewhere else.
 */
export const ACCENT = {
  /** Fur, pushed to a saturated cyan that still sits on the fur's hue. */
  energy: shift(regionHex('fur', '#4487a4'), +6, +0.45, +0.18),
  /** The same hue taken almost to white — what the hot core of an effect is made of. */
  core: shift(regionHex('fur', '#4487a4'), 0, -0.15, +0.42),
  /** Belly pale blue, lifted — soft, cold, low-energy motes. */
  mote: shift(regionHex('belly', '#80a8ba'), 0, +0.15, +0.20),
  /** Horn grey, warmed slightly — dust and grit come off the ground, not off the fur. */
  dust: shift(regionHex('horn', '#728592'), -12, -0.04, +0.16),
  /** Wristband violet, lifted into a readable impact colour. */
  impact: shift(regionHex('wristband', '#32314d'), +8, +0.45, +0.42),
  /**
   * A warm cheek pink — and the largest hue move in this set, so it is worth being explicit about.
   *
   * Nothing on this character is warm. The measured palette is cyan fur, paler cyan belly, grey
   * horn, off-white eye, near-black iris and a violet-navy wristband. A blush drawn in any of them
   * does not read as a blush; it reads as a bruise or as more fur. So this walks the wristband
   * violet round to pink and lifts it hard. It is still derived from a measured colour by a stated
   * move, but it is the one accent that lands outside the hues the monster actually wears, and
   * that is a deliberate stylisation rather than a measurement.
   */
  blush: shift(regionHex('wristband', '#32314d'), +72, +0.46, +0.44),
} as const;

export const PALETTE_PROVENANCE = paletteEvidence.regions.map((r) => ({
  id: r.id, hex: r.hex, share: r.share, rule: r.rule,
}));

// ---------------------------------------------------------------- sockets

export type SocketKind = 'effect' | 'grip' | 'attachment';
export interface SocketSpec {
  id: string;
  kind: SocketKind;
  bone: string;
  offset: [number, number, number];
  derivation: string;
  sampleCount: number;
}

/**
 * Mapped rather than cast: the JSON types `offset` as `number[]`, and a socket with two components
 * is a socket at the wrong place, so the tuple is rebuilt element by element.
 */
export const SOCKETS: SocketSpec[] = socketEvidence.sockets.map((s) => ({
  id: s.id,
  kind: s.kind as SocketKind,
  bone: s.bone,
  offset: [s.offset[0], s.offset[1], s.offset[2]] as [number, number, number],
  derivation: s.derivation,
  sampleCount: s.sampleCount,
}));

/** Which axis is lateral, which way the face points — measured, not assumed. */
export const FRAME = socketEvidence.frame;

/**
 * The direction the monster faces, in world space.
 *
 * Worth stating because the spec's own `coordinateFrame` note says "subject faces -z", and the
 * measurement disagrees: the figure's lateral axis is Z (a 2.57-unit arm span against a 1.01-unit
 * body depth) and its face points +X. The camera the export shipped was therefore pointed at the
 * character's back. This is derived from where the dark eye cluster sits relative to the head
 * joint, so it follows the data rather than the note.
 */
export const FRONT_DIRECTION = new THREE.Vector3(
  FRAME.depthAxis === 'x' ? FRAME.frontSign : 0,
  0,
  FRAME.depthAxis === 'z' ? FRAME.frontSign : 0,
).normalize();

/**
 * A three-quarter view of the face, built from that direction rather than from the static
 * export's camera. Distance fits the 1.9-unit figure at a 30-degree vertical FOV with margin.
 */
export function frontCamera(distance = 3.0 * FIGURE_HEIGHT, yawDegrees = 30, height = 0.68 * FIGURE_HEIGHT) {
  const yaw = THREE.MathUtils.degToRad(yawDegrees);
  const side = new THREE.Vector3(-FRONT_DIRECTION.z, 0, FRONT_DIRECTION.x);
  const position = new THREE.Vector3()
    .addScaledVector(FRONT_DIRECTION, Math.cos(yaw) * distance)
    .addScaledVector(side, Math.sin(yaw) * distance);
  position.y = height;
  return { position, target: new THREE.Vector3(0, 0.44 * FIGURE_HEIGHT, 0), fov: 30 };
}

// ---------------------------------------------------------------- clips

export interface ClipProfile {
  name: string;
  duration: number;
  /** Stage R3 section 2 classes this clip measured into. May be empty: not every clip is one of them. */
  classes: string[];
  /** From the pose-return rule, not from the clip's name or its travel. */
  loop: boolean;
  features: Record<string, number>;
  gateR1: 'pass' | 'fail' | 'unevaluated';
}

export const CLIP_PROFILES: Record<string, ClipProfile> = Object.fromEntries(
  gateEvidence.clips.map((c) => [c.name, {
    name: c.name,
    duration: c.duration,
    classes: (c as { classes?: string[] }).classes ?? [],
    loop: (c as { loop?: boolean }).loop ?? false,
    features: (c as { features?: Record<string, number> }).features ?? {},
    gateR1: ((c as { gateR1?: string }).gateR1 ?? 'unevaluated') as ClipProfile['gateR1'],
  }]),
);

export const GATE_R1 = {
  verdict: gateEvidence.verdict,
  maxSampledBindingDelta: gateEvidence.maxSampledBindingDelta,
  epsilon: gateEvidence.epsilon,
  samplesPerClip: gateEvidence.samplesPerClip,
  clipsMeasured: gateEvidence.clipsMeasured,
  clipsTotal: gateEvidence.clipsTotal,
  // Empty in the JSON as it stands, which types it as `never[]`; declared so a future clip that
  // cannot be measured has somewhere to be reported rather than silently vanishing.
  unevaluated: gateEvidence.clipsUnevaluated as { name: string; missingInputs?: string[] }[],
};

/** Clips that measured into a given Stage R3 class. */
export function clipsInClass(className: string): string[] {
  return Object.values(CLIP_PROFILES).filter((c) => c.classes.includes(className)).map((c) => c.name);
}
