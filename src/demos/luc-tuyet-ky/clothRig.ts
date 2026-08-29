import * as THREE from 'three';
import type { DecodedPart } from './meshCodec';
import { LANDMARKS, type RegionGeometry } from './costumeSegmentation';

/**
 * Give the gown and the hair joints of their own, then drive those joints with a solver instead of
 * with the body clips.
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * The auto-rig bound the gown to the leg joints, so a raised knee carried the whole panel up with
 * it, and a split stance pulled the front panel apart because its left half was on L_Calf* and its
 * right half on R_Calf*. Re-weighting the gown onto the hip alone would stop the dragging but leave
 * a rigid cone that ignores the motion entirely — right by the letter of "must not be dragged",
 * wrong by the eye.
 *
 * So the gown gets a real skirt rig: a ring of joint chains hanging from the pelvis, one per panel
 * sector, re-weighted so no gown vertex has any leg influence at all. The chains are then integrated
 * as verlet particles under gravity with the pelvis as their moving anchor, which is what makes the
 * skirt lag, swing and settle on its own. The legs cannot drag it because they are not in its
 * weights; they can only push it, through the capsule colliders below.
 *
 * The hair is the same story one joint up: it was bound to Spine01 and the clavicles, so a shoulder
 * roll sheared it. It hangs from the head joint here and swings by the same solver.
 *
 * WHY VERLET AND NOT A SPRING ON THE ROTATION
 * -------------------------------------------
 * A rotational spring per joint has to be tuned per joint length or the tip overshoots while the
 * root is still stiff. Position-based verlet with a hard length constraint is unconditionally stable
 * at any step, gives inertia for free — the anchor moves, the particle does not, and the difference
 * IS the lag — and the length constraint means the panel can never stretch, which was the other half
 * of the original artefact.
 */

/** Rest heights of the skirt joints, top (anchor, rigid to the pelvis) to hem. */
const SKIRT_LEVELS = [LANDMARKS.beltY, 0.4, 0.27, 0.14] as const;
const SKIRT_SECTORS = 10;

/** Rest heights of the hair joints, top (anchor, rigid to the head) to tip. */
const HAIR_LEVELS = [LANDMARKS.scalpY, 0.8, 0.7, 0.6] as const;
const HAIR_SECTORS = 8;

export interface StrandTuning {
  /** 0..1 pull back to the animated rest pose each step. Higher = stiffer cloth. */
  stiffness: number;
  /** 0..1 velocity retained per step. Lower = settles sooner. */
  damping: number;
  /** Downward acceleration in figure heights per second squared. */
  gravity: number;
  /** How much of the anchor's motion is handed to the particles directly; 1 = no lag at all. */
  inertia: number;
}

/**
 * Gravity dominates; stiffness only keeps the panels spread.
 *
 * The first tuning here had it the other way round — stiffness 0.16 against a gravity term worth
 * 0.0007 per frame — and the result was a skirt welded to the pelvis's orientation: the front-kick
 * clip pitches the hips through about a right angle, so "rest" pointed backwards and upwards and the
 * panels went with it, measured at a hem 0.96 out from the axis against 0.17 in bind pose and
 * sitting above the waist. Cloth does not do that.
 *
 * These numbers are the ones the sweep in `scripts/verify-luc-tuyet-ky-rig.md` settled on, measured
 * over dance, spin, front-kick and run: hem radius p95 0.199 against 0.150 in bind pose, and the
 * lowest gown vertex holding at y 0.118 against 0.087 — the panels swing, and they come back down.
 *
 * Gravity reads high because it is: 28 against the ~5.2 that real gravity works out to in figure
 * heights. This gown is armoured — plated shoulders, a metal belt, weighted hem panels — and the
 * clips are fast, so cloth tuned to a bedsheet billows through the whole set. The heavier number is
 * a statement about the garment, not a fudge to hide an instability; the sweep above shows the
 * envelope closing smoothly as it rises, with no threshold anywhere.
 */
const SKIRT_TUNING: StrandTuning = { stiffness: 0.003, damping: 0.88, gravity: 28, inertia: 0.5 };
/*
 * The hair is tuned stiffer and better damped than the gown, and the numbers came from measurement
 * rather than taste. The eight hair chains are solved independently, so at low stiffness two chains
 * 45 degrees apart could swing far enough apart to draw the surface between them out to 0.063 of
 * figure height on the run clip. Holding them nearer their rest pose brings that to 0.025 and costs
 * the gown nothing, which is the right trade for this character: her hair is a heavy straight fall,
 * not loose curls, and it should read as weight rather than as float.
 */
const HAIR_TUNING: StrandTuning = { stiffness: 0.08, damping: 0.85, gravity: 14, inertia: 0.45 };

/** Ceiling on per-frame particle travel, in world units — a guard against a clip switch teleporting an anchor. */
const MAX_STEP = 0.25;

/**
 * Anchor movement in one step that can only be a cut, not a motion.
 *
 * A looping clip teleports the skeleton from its last frame back to its first, and the solver cannot
 * tell that from a movement: it sees the anchor jump and starts swinging after it. Measured on
 * `flee_02`, whose 3.71 s puts the wrap at frame 222, a hair edge stretched by 0.060 of figure
 * height at frame 225 while every other edge in that mesh stayed under 0.020 — a whip, once per
 * loop, forever. Past this distance the strand is re-seeded instead of chased, which is invisible
 * because the body jumped too: they land together.
 *
 * 0.4 world units in one step is roughly a fifth of the figure's height. Nothing these clips do to a
 * pelvis or a head at 60 fps comes close, so ordinary motion never trips it.
 */
const TELEPORT_JUMP = 0.4;

/** Ground plane. The rig normalises the figure feet-at-zero, so this is not a tuned number. */
const FLOOR_Y = 0;

/** Height over which a region fades from its strand joints onto the body joint it is sewn to. */
const ATTACH_BAND = 0.05;

interface Strand {
  /** bones[0] is the anchor: it is parented into the body skeleton and never solved. */
  bones: THREE.Bone[];
  /** Rest local offset of each bone from its parent, used to rebuild the unsolved pose. */
  restOffset: THREE.Vector3[];
  lengths: number[];
  particles: THREE.Vector3[];
  previous: THREE.Vector3[];
  /** This frame's undynamic pose, recomputed from the clip before every solve. */
  restWorld: THREE.Vector3[];
  /** Last frame's anchor position, so the solver can hand part of the anchor's motion forward. */
  lastAnchor: THREE.Vector3;
  anchorSeen: boolean;
  tuning: StrandTuning;
}

/** A moving sphere that pushes cloth out of a limb, in the figure's own space. */
interface Collider {
  bone: THREE.Bone;
  offset: THREE.Vector3;
  radius: number;
}

export interface ClothRig {
  /** Every joint added to the skeleton for the costume, in skeleton index order. */
  bones: THREE.Bone[];
  strands: Strand[];
  colliders: Collider[];
  /** Advance the solver. Call after the mixer has posed the body skeleton for this frame. */
  update(deltaSeconds: number): void;
  /** Drop all lag and snap the costume to its rest pose — used when a clip is switched or reset. */
  reset(): void;
  enabled: boolean;
}

function boneWorldRest(bones: THREE.Bone[]): THREE.Matrix4[] {
  const world: THREE.Matrix4[] = [];
  for (const bone of bones) {
    const local = new THREE.Matrix4().compose(bone.position, bone.quaternion, bone.scale);
    const parent = bone.parent instanceof THREE.Bone ? world[bones.indexOf(bone.parent)] : null;
    world.push(parent ? new THREE.Matrix4().multiplyMatrices(parent, local) : local);
  }
  return world;
}

/**
 * Median radius of a region's vertices in one (sector, level) cell, so the joints are laid out
 * inside the cloth they drive rather than on a guessed cylinder.
 *
 * Cells the panel does not reach — the front slit of this gown is a real gap — come back as null and
 * are filled from their neighbours by the caller, which keeps the ring continuous without inventing
 * a joint in mid-air.
 */
function measureRadii(
  part: DecodedPart,
  sourceVertex: Uint32Array,
  sectors: number,
  levels: readonly number[],
  axis: { x: number; z: number },
): (number | null)[][] {
  const buckets: number[][][] = levels.map(() => Array.from({ length: sectors }, () => [] as number[]));
  for (const s of sourceVertex) {
    const x = part.position[s * 3] - axis.x;
    const y = part.position[s * 3 + 1];
    const z = part.position[s * 3 + 2] - axis.z;
    const radius = Math.hypot(x, z);
    let angle = Math.atan2(z, x) / (Math.PI * 2);
    if (angle < 0) angle += 1;
    const sector = Math.min(sectors - 1, Math.floor(angle * sectors));
    // Nearest level by height; the cell only has to be representative, not a partition.
    let best = 0;
    for (let l = 1; l < levels.length; l += 1) {
      if (Math.abs(y - levels[l]) < Math.abs(y - levels[best])) best = l;
    }
    buckets[best][sector].push(radius);
  }
  return buckets.map((row) =>
    row.map((values) => {
      if (!values.length) return null;
      values.sort((a, b) => a - b);
      return values[values.length >> 1];
    }),
  );
}

function fillGaps(radii: (number | null)[][], fallback: number): number[][] {
  return radii.map((row) => {
    const sectors = row.length;
    const filled = row.slice();
    for (let i = 0; i < sectors; i += 1) {
      if (filled[i] !== null) continue;
      // Walk both ways around the ring to the nearest measured sector and average the two.
      let left: number | null = null;
      let right: number | null = null;
      for (let d = 1; d <= sectors; d += 1) {
        if (left === null) left = row[(i - d + sectors * 2) % sectors];
        if (right === null) right = row[(i + d) % sectors];
        if (left !== null && right !== null) break;
      }
      filled[i] = left !== null && right !== null ? (left + right) / 2 : (left ?? right ?? fallback);
    }
    return filled as number[];
  });
}

interface StrandRingOptions {
  name: string;
  parent: THREE.Bone;
  parentWorld: THREE.Matrix4;
  sectors: number;
  levels: readonly number[];
  axis: { x: number; z: number };
  radii: number[][];
  tuning: StrandTuning;
}

/**
 * Build one ring of chains and return both the joints and the bind data the skin needs.
 *
 * Every joint is created with an identity rotation and a pure translation, so its rest world
 * orientation is the identity and the solver's "which way was this bone pointing" question has a
 * constant answer. That is what lets the update loop drive the joints by direction alone.
 */
function buildStrandRing(options: StrandRingOptions): { strands: Strand[]; bones: THREE.Bone[] } {
  const { name, parent, parentWorld, sectors, levels, axis, radii, tuning } = options;
  const parentWorldInverse = parentWorld.clone().invert();
  const strands: Strand[] = [];
  const bones: THREE.Bone[] = [];

  for (let s = 0; s < sectors; s += 1) {
    const angle = ((s + 0.5) / sectors) * Math.PI * 2;
    const chain: THREE.Bone[] = [];
    const restOffset: THREE.Vector3[] = [];
    const lengths: number[] = [];
    let previousWorld: THREE.Vector3 | null = null;

    for (let l = 0; l < levels.length; l += 1) {
      const radius = radii[l][s];
      const world = new THREE.Vector3(axis.x + Math.cos(angle) * radius, levels[l], axis.z + Math.sin(angle) * radius);
      const bone = new THREE.Bone();
      bone.name = `${name}_s${s}_l${l}`;
      if (l === 0) {
        // Anchor: expressed in the body joint's frame so the ring rides the pelvis (or the head).
        bone.position.copy(world.clone().applyMatrix4(parentWorldInverse));
        parent.add(bone);
      } else {
        bone.position.copy(world).sub(previousWorld as THREE.Vector3);
        chain[l - 1].add(bone);
        lengths.push(bone.position.length());
      }
      restOffset.push(bone.position.clone());
      chain.push(bone);
      bones.push(bone);
      previousWorld = world;
    }

    strands.push({
      bones: chain,
      restOffset,
      lengths,
      particles: chain.map(() => new THREE.Vector3()),
      previous: chain.map(() => new THREE.Vector3()),
      restWorld: chain.map(() => new THREE.Vector3()),
      lastAnchor: new THREE.Vector3(),
      anchorSeen: false,
      tuning,
    });
  }
  return { strands, bones };
}

/** Four joint influences for one vertex, already normalised. */
export interface VertexWeights {
  index: [number, number, number, number];
  weight: [number, number, number, number];
}

export interface CostumeBinding {
  /**
   * New joints appended to the skeleton, in order.
   *
   * No inverse bind matrices travel with them: the factory builds the whole hierarchy first and then
   * lets THREE.Skeleton derive every inverse from the assembled bind pose, which is the only way the
   * `bindMatrixInverse * boneMatrix * bindMatrix = I` identity three's skinning shader assumes can
   * hold once the figure sits under a scaled parent.
   */
  bones: THREE.Bone[];
  strands: Strand[];
  /** Strands grouped by the ring they belong to, in sector order, so the solver can couple them. */
  strandRings: Strand[][];
  /**
   * What a ring would give this source vertex, whatever mesh it ends up in.
   *
   * Exposed as a pure function of the SOURCE vertex — not written straight onto a geometry — because
   * a vertex on a region border exists in two meshes at once, and the only way those copies can be
   * guaranteed to move together is for both to ask the same question and get the same answer. The
   * factory is what applies it, uniformly, to every mesh.
   */
  ringWeightsAt(source: number, region: 1 | 2): VertexWeights | null;
}

/**
 * Lay out the costume joints and produce the weights that put the gown and the hair on them.
 *
 * The weights are bilinear over (sector, level): a vertex takes the two chains either side of its
 * azimuth and the two joints above and below its height, which is exactly four influences — the
 * number a THREE.SkinnedMesh carries — so nothing has to be dropped and renormalised. Bilinear over
 * the ring is also what keeps the panel continuous: neighbouring vertices never jump between chains,
 * so the seam that used to tear between L_Calf and R_Calf cannot re-form here.
 */
export function planCostumeRig(
  part: DecodedPart,
  regions: RegionGeometry[],
  bodyBones: THREE.Bone[],
): CostumeBinding {
  const worldRest = boneWorldRest(bodyBones);
  const boneByName = new Map(bodyBones.map((b, i) => [b.name, i] as const));
  const pelvisIndex = boneByName.get('Pelvis') ?? boneByName.get('Hip') ?? 0;
  const headIndex = boneByName.get('Head') ?? 0;

  const dress = regions.find((r) => r.region === 'dress');
  const hair = regions.find((r) => r.region === 'hair');
  const axis = LANDMARKS.hipAxis;

  const rings: Array<{
    region: 'dress' | 'hair';
    levels: readonly number[];
    sectors: number;
    strands: Strand[];
    bones: THREE.Bone[];
    /** Skeleton index of the body joint the anchor ring is rigid to. */
    anchorBone: number;
    /** Above this height the region rides the anchor joint alone (bodice seam / scalp cap). */
    rigidAbove: number;
    axis: { x: number; z: number };
  }> = [];

  if (dress) {
    const radii = fillGaps(measureRadii(part, dress.sourceVertex, SKIRT_SECTORS, SKIRT_LEVELS, axis), 0.11);
    const built = buildStrandRing({
      name: 'LTK_Skirt',
      parent: bodyBones[pelvisIndex],
      parentWorld: worldRest[pelvisIndex],
      sectors: SKIRT_SECTORS,
      levels: SKIRT_LEVELS,
      axis,
      radii,
      tuning: SKIRT_TUNING,
    });
    rings.push({ region: 'dress', levels: SKIRT_LEVELS, sectors: SKIRT_SECTORS, ...built, anchorBone: pelvisIndex, rigidAbove: LANDMARKS.beltY, axis });
  }

  if (hair) {
    const headAxis = { x: worldRest[headIndex].elements[12], z: worldRest[headIndex].elements[14] };
    const radii = fillGaps(measureRadii(part, hair.sourceVertex, HAIR_SECTORS, HAIR_LEVELS, headAxis), 0.06);
    const built = buildStrandRing({
      name: 'LTK_Hair',
      parent: bodyBones[headIndex],
      parentWorld: worldRest[headIndex],
      sectors: HAIR_SECTORS,
      levels: HAIR_LEVELS,
      axis: headAxis,
      radii,
      tuning: HAIR_TUNING,
    });
    rings.push({ region: 'hair', levels: HAIR_LEVELS, sectors: HAIR_SECTORS, ...built, anchorBone: headIndex, rigidAbove: LANDMARKS.scalpY, axis: headAxis });
  }

  const bones = rings.flatMap((r) => r.bones);
  const strands = rings.flatMap((r) => r.strands);
  const strandRings = rings.map((r) => r.strands);

  // Where each ring's joints start once they are appended after the body's.
  const ringBase = new Map<number, number>();
  {
    let base = bodyBones.length;
    for (const ring of rings) {
      ringBase.set(ring.region === 'dress' ? 1 : 2, base);
      base += ring.bones.length;
    }
  }

  const ringWeightsAt = (source: number, region: 1 | 2): VertexWeights | null => {
    const ring = rings.find((r) => (r.region === 'dress' ? 1 : 2) === region);
    const base = ringBase.get(region);
    if (!ring || base === undefined) return null;

    const x = part.position[source * 3] - ring.axis.x;
    const y = part.position[source * 3 + 1];
    const z = part.position[source * 3 + 2] - ring.axis.z;

    if (y >= ring.rigidAbove + ATTACH_BAND) {
      // The bodice seam and the scalp cap ride the body joint outright, which is what keeps the
      // gown's top ring welded to the waist and the hair cap welded to the skull.
      return { index: [ring.anchorBone, 0, 0, 0], weight: [1, 0, 0, 0] };
    }

    const { levels, sectors } = ring;
    let angle = Math.atan2(z, x) / (Math.PI * 2);
    if (angle < 0) angle += 1;
    const sectorPosition = angle * sectors - 0.5;
    const sectorLow = Math.floor(sectorPosition);
    const sectorBlend = sectorPosition - sectorLow;
    const sectorA = ((sectorLow % sectors) + sectors) % sectors;
    const sectorB = (sectorA + 1) % sectors;

    // Levels descend, so the search walks down until the vertex is above the next joint.
    let level = 0;
    while (level < levels.length - 2 && y < levels[level + 1]) level += 1;
    const span = levels[level] - levels[level + 1];
    const levelBlend = span > 1e-6 ? THREE.MathUtils.clamp((levels[level] - y) / span, 0, 1) : 0;

    const at = (sector: number, l: number): number => base + sector * levels.length + l;
    const index: [number, number, number, number] = [
      at(sectorA, level), at(sectorB, level), at(sectorA, level + 1), at(sectorB, level + 1),
    ];
    const raw = [
      (1 - sectorBlend) * (1 - levelBlend),
      sectorBlend * (1 - levelBlend),
      (1 - sectorBlend) * levelBlend,
      sectorBlend * levelBlend,
    ];
    const total = raw[0] + raw[1] + raw[2] + raw[3];
    const weight: [number, number, number, number] = total > 0
      ? [raw[0] / total, raw[1] / total, raw[2] / total, raw[3] / total]
      : [1, 0, 0, 0];

    /*
     * Fade into the attachment rather than stepping onto it.
     *
     * Above `rigidAbove` a vertex rides the body joint outright; below it, the strand joints. A hard
     * switch between the two is a step in the deformation exactly where the costume is sewn on, and
     * on the hair it showed: the run clip stretched an edge there by 0.066 of figure height, where
     * every other hair edge stayed under 0.003. Fading over a band spreads that step across a
     * centimetre of surface instead of one ring of vertices.
     *
     * The anchor replaces the LIGHTEST strand influence, so the vertex still never exceeds the four
     * a SkinnedMesh carries.
     */
    if (y >= ring.rigidAbove) {
      const t = (y - ring.rigidAbove) / ATTACH_BAND;
      let lightest = 0;
      for (let k = 1; k < 4; k += 1) if (weight[k] < weight[lightest]) lightest = k;
      for (let k = 0; k < 4; k += 1) weight[k] *= 1 - t;
      const freed = weight[lightest];
      weight[lightest] = 0;
      index[lightest] = ring.anchorBone;
      weight[lightest] = t + freed;
      const sum = weight[0] + weight[1] + weight[2] + weight[3];
      if (sum > 0) for (let k = 0; k < 4; k += 1) weight[k] /= sum;
    }
    return { index, weight };
  };

  return { bones, strands, strandRings, ringWeightsAt };
}

/**
 * Wire the solver to a posed skeleton.
 *
 * `colliderBones` are the limbs the cloth must not sink into. They are read, never written, so the
 * body animation stays exactly what the clip says it is — the cloth moves around the leg, the leg
 * never moves for the cloth.
 */
export function createClothRig(strandRings: Strand[][], skeletonBones: THREE.Bone[]): ClothRig {
  const strands = strandRings.flat();
  const byName = new Map(skeletonBones.map((b) => [b.name, b] as const));
  const colliders: Collider[] = [];
  // Radii come from the measured inner lobe of the radial histogram (the leg surface sits at
  // r≈0.05-0.065 of figure height), padded slightly so the cloth rides just clear of the skin.
  for (const [name, radius, offsetY] of [
    ['L_Thigh', 0.072, -0.09],
    ['R_Thigh', 0.072, -0.09],
    ['L_Calf', 0.06, -0.09],
    ['R_Calf', 0.06, -0.09],
  ] as const) {
    const bone = byName.get(name);
    if (bone) colliders.push({ bone, offset: new THREE.Vector3(0, offsetY, 0), radius });
  }

  const rig: ClothRig = {
    bones: strands.flatMap((s) => s.bones),
    strands,
    colliders,
    enabled: true,
    reset: () => {
      for (const strand of strands) {
        for (let i = 0; i < strand.bones.length; i += 1) {
          strand.bones[i].quaternion.identity();
          strand.bones[i].position.copy(strand.restOffset[i]);
        }
        strand.bones[0].updateMatrixWorld(true);
        for (let i = 0; i < strand.bones.length; i += 1) {
          strand.particles[i].setFromMatrixPosition(strand.bones[i].matrixWorld);
          strand.previous[i].copy(strand.particles[i]);
        }
        strand.anchorSeen = false;
      }
    },
    update: (deltaSeconds: number) => {
      if (!rig.enabled) return;
      // Clamped so a tab that was backgrounded for a second does not resume with a metre of
      // accumulated gravity and fling the skirt over the character's head.
      const dt = Math.min(deltaSeconds, 1 / 30);
      if (dt <= 0) return;

      const worldColliders = colliders.map((c) => ({
        centre: c.offset.clone().applyMatrix4(c.bone.matrixWorld),
        radius: c.radius,
      }));

      const carry = new THREE.Vector3();
      const velocity = new THREE.Vector3();
      const delta = new THREE.Vector3();
      const push = new THREE.Vector3();
      const currentDirection = new THREE.Vector3();
      const wantedDirection = new THREE.Vector3();
      const turn = new THREE.Quaternion();
      const worldRotation = new THREE.Quaternion();
      const parentRotation = new THREE.Quaternion();

      for (const strand of strands) {
        const { bones, particles, previous, lengths, tuning, restWorld } = strand;

        /*
         * Put the chain back in its rest pose FIRST, and read the targets from that.
         *
         * This is the whole stability argument. Left in last frame's solved pose, `restWorld` would
         * be wherever the solver had already pushed the chain, so the stiffness term would pull each
         * particle toward its own previous output instead of toward the pose the body is actually in
         * — a feedback loop with no fixed point. Measured before this reset, the gown left its bind
         * bounds within four seconds of the dance clip (hem radius 0.171 -> 0.568) and the front kick
         * threw the whole skirt above the waist (y 0.44-0.78). Resetting first makes every target a
         * function of the clip alone, so the only thing the solver can add is lag.
         */
        for (let i = 1; i < bones.length; i += 1) bones[i].quaternion.identity();
        bones[0].updateMatrixWorld(true);
        for (let i = 0; i < bones.length; i += 1) restWorld[i].setFromMatrixPosition(bones[i].matrixWorld);

        // The anchor is wherever the body clip has just put it; the rest of the chain trails it.
        particles[0].copy(restWorld[0]);
        previous[0].copy(particles[0]);

        // How far the pelvis (or head) travelled this frame. Handing a fraction of it straight to
        // every particle is what stops a fast clip from leaving the skirt behind the body entirely:
        // without it the panels only ever catch up through the stiffness term, which reads as the
        // cloth being made of lead. The remainder is the lag that makes it look like cloth at all.
        const jumped = strand.anchorSeen && particles[0].distanceTo(strand.lastAnchor) > TELEPORT_JUMP;
        if (jumped) {
          // A cut, not a movement: land the whole strand on the pose the clip just asked for and
          // drop the velocity it accumulated chasing the old one.
          for (let i = 0; i < bones.length; i += 1) {
            particles[i].copy(restWorld[i]);
            previous[i].copy(restWorld[i]);
          }
        }
        if (strand.anchorSeen && !jumped) carry.subVectors(particles[0], strand.lastAnchor).multiplyScalar(tuning.inertia);
        else carry.set(0, 0, 0);
        strand.lastAnchor.copy(particles[0]);
        strand.anchorSeen = true;

        for (let i = 1; i < bones.length; i += 1) {
          velocity.subVectors(particles[i], previous[i]).multiplyScalar(tuning.damping);
          previous[i].copy(particles[i]);
          particles[i].add(velocity);
          // The carry is a TRANSLATION, so it moves `previous` with it. Added to the particle alone it
          // would land in next frame's `particles - previous` as velocity, and every frame the anchor
          // moved would deposit more of it — an energy pump that flung the hem out to twice its bind
          // radius and would not settle no matter how the stiffness and gravity were traded off.
          particles[i].add(carry);
          previous[i].add(carry);
          particles[i].y -= tuning.gravity * dt * dt;
          particles[i].lerp(restWorld[i], tuning.stiffness);

          // How far the particle may travel in one frame. Distance from the rest pose is NOT capped —
          // a hanging panel is supposed to be far from a pitched-back pelvis's idea of rest, and
          // capping that is what pinned the skirt to the hips before. The hard length constraint
          // below is the real bound on where a particle can end up; this only stops a clip switch
          // that teleports the anchor from handing the chain a velocity it whips around for seconds.
          delta.subVectors(particles[i], previous[i]);
          const travelled = delta.length();
          if (travelled > MAX_STEP) particles[i].copy(previous[i]).addScaledVector(delta, MAX_STEP / travelled);

          for (const collider of worldColliders) {
            delta.subVectors(particles[i], collider.centre);
            const distance = delta.length();
            if (distance < collider.radius && distance > 1e-6) {
              push.copy(delta).multiplyScalar((collider.radius - distance) / distance);
              particles[i].add(push);
            }
          }

          // Hard length constraint, so nothing above can stretch the panel.
          delta.subVectors(particles[i], particles[i - 1]);
          const length = delta.length();
          if (length > 1e-6) particles[i].copy(particles[i - 1]).addScaledVector(delta, lengths[i - 1] / length);

          // Floor, applied after the length constraint so it is the one that wins. The figure is
          // normalised feet-at-zero, so the ground is y = 0 in the space these particles live in and
          // this is not a tuned number.
          //
          // It keeps the driven JOINTS above the floor, which is all a particle solver can do here.
          // Skin hanging below the last joint of a chain still follows that joint rigidly, so in a
          // deep crouch — `lift_heavy` drops the hip from 1.077 to 0.534 — the very bottom of the
          // gown reaches about 0.2 below the ground plane and would need either a fifth joint per
          // panel or a per-vertex clamp in the shader to catch. Both cost more than the artefact
          // does: it happens in one clip of the eighteen, under a figure that is itself crouching
          // over the spot, against a translucent frost disc. Left as measured rather than hidden.
          if (particles[i].y < FLOOR_Y) particles[i].y = FLOOR_Y;
        }

      }

      /*
       * Neighbouring panels are deliberately NOT coupled to each other.
       *
       * A lateral constraint holding adjacent chains at their rest spacing is the textbook way to
       * make a ring of strands behave as one sheet, and it was tried here across four clips at four
       * strengths. Every one of them made the result worse, not better: the gown's worst edge went
       * from 0.009 of figure height to 0.087, and the hair's from 0.063 to 0.077, with no strength
       * that traded them off. The reason is that this gown is not a closed ring — it has a real slit
       * up the front — so constraining sectors that the mesh does not actually join pulls the two
       * sides of the slit around, and the correction then fights the length constraint that runs
       * after it. The chains are left independent, and the measurements are in the gate.
       */

      // Turn the joints only once every particle is settled, so each one reads a parent whose world
      // matrix is already final for this frame.
      for (const strand of strands) {
        const { bones, particles, lengths, restOffset } = strand;
        for (let i = 1; i < bones.length; i += 1) {
          delta.subVectors(particles[i], particles[i - 1]);
          const length = delta.length();
          if (length > 1e-6) particles[i].copy(particles[i - 1]).addScaledVector(delta, lengths[i - 1] / length);
          if (particles[i].y < FLOOR_Y) particles[i].y = FLOOR_Y;
        }
        for (let i = 1; i < bones.length; i += 1) {
          const parent = bones[i - 1];
          currentDirection.copy(restOffset[i]).applyMatrix4(parent.matrixWorld).sub(particles[i - 1]);
          wantedDirection.subVectors(particles[i], particles[i - 1]);
          if (currentDirection.lengthSq() < 1e-10 || wantedDirection.lengthSq() < 1e-10) continue;
          currentDirection.normalize();
          wantedDirection.normalize();
          turn.setFromUnitVectors(currentDirection, wantedDirection);
          // Compose in world space, then divide out the GRANDparent — the frame this joint's local
          // rotation is actually expressed in. Cancelling the joint's own world rotation instead
          // leaves the parent's contribution in twice, which winds the chain up a little more every
          // frame until the panel is stretched across the scene.
          parent.getWorldQuaternion(worldRotation);
          worldRotation.premultiply(turn);
          if (parent.parent) {
            parent.parent.getWorldQuaternion(parentRotation);
            parent.quaternion.copy(parentRotation.invert().multiply(worldRotation));
          } else {
            parent.quaternion.copy(worldRotation);
          }
          parent.updateMatrixWorld(true);
        }
        bones[bones.length - 1].updateMatrixWorld(true);
      }
    },
  };
  return rig;
}
