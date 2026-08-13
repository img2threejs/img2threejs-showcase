import * as THREE from 'three';

/**
 * Lee Sin — code-only, low-poly procedural character reconstruction.
 *
 * The macro blockout is intentionally lean and athletic: narrow waist, long
 * limbs, a continuous shoulder wedge, straight knee-length pants, exposed
 * calves and short ankle boots. Decorative identity systems stay attached to
 * the same pivots so later passes can replace them without changing the rig.
 */

export type LeeSinOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  animate?: boolean;
};

type Vec3 = [number, number, number];

const PALETTE = {
  skin: 0xffad68,
  skinDeep: 0x8b3b22,
  hair: 0x070707,
  blindfold: 0xd72f35,
  tattoo: 0xe04449,
  pants: 0x2d2b35,
  pantsDark: 0x171a22,
  sash: 0xc13a3d,
  wrap: 0x58302b,
  gold: 0xf0b72b,
  goldBright: 0xffdc6a,
  sole: 0x1f1a16,
};

const PASS1_HAND_SCALE: Vec3 = [0.70, 0.75, 0.70];
// The current head silhouette is undersized against both the admitted hero
// plate and the supplied turnaround: enlarge the whole local head frame so
// skull, blindfold, scalp cap, bun, and locks keep one anatomical scale.
const HEAD_FRAME_SCALE: Vec3 = [1.12, 1.07, 1.00];

/**
 * Pass 1 is deliberately a parameter block, not a collection of unrelated
 * magic nudges.  It controls only the macro silhouette and the named pivot
 * spacing; surface marks, hair, rings, and look-dev remain in later passes.
 */
const PASS1_PROPORTIONS = {
  torsoWidthScale: 0.84,
  // The admitted plate has a broad upper rib-cage/clavicle span even though
  // its waist remains narrow.  Keep the current measured shoulder envelope
  // until a dedicated shoulder-contour pass can widen the chest without
  // pushing the arm silhouette outside the admitted mask.
  shoulderWidthScale: 0.98,
  // Profile audit v144 showed the closed surface was still reading as a thin
  // front/back panel.  This scales only the section depth; the front x/y
  // contour, pivots, and arm reach remain unchanged.
  torsoDepthScale: 0.88,
  shoulderX: 0.95,
  shoulderY: 0.45,
  shoulderRotationZ: 0.28,
  elbowX: 0.22,
  elbowY: -0.44,
  // The lower-arm rows were 2–4% inside the admitted front silhouette.  Move
  // the wrist pivot laterally while preserving its height so hand reach grows
  // without changing the shoulder/elbow transition.
  wristX: 0.66,
  wristY: -1.89,
  hipX: 0.60,
  kneeY: -2.62,
  ankleY: -1.08,
  footLift: 0.12,
} as const;

function torsoWidthScaleAt(y: number): number {
  return THREE.MathUtils.lerp(
    PASS1_PROPORTIONS.torsoWidthScale,
    PASS1_PROPORTIONS.shoulderWidthScale,
    THREE.MathUtils.smoothstep(y, 0.28, 0.78),
  );
}

/**
 * Enabling sheen darkens the material's OWN diffuse base, by exactly this coefficient times the
 * effective sheen strength:
 *
 *   `float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );`
 *   `outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;`
 *   — three@0.169.0 `ShaderLib/meshphysical.glsl.js:205,207`
 *
 * `sheen` is folded into `sheenColor` before upload (`WebGLMaterials.js:408`), so the strength that
 * matters is the scalar times the tint's largest channel — which is what `max3` reads.
 */
const SHEEN_ENERGY_COMPENSATION = 0.157;

/**
 * The base colour to AUTHOR so the RENDER lands on `sampled` once sheen has darkened it.
 *
 * This exists as a function rather than as pre-multiplied hex literals so that `PALETTE` stays the
 * single source of truth for what was actually sampled off the reference. Hardcoding the compensated
 * values orphaned five palette entries: tuning `PALETTE.sash` changed nothing, because the material
 * no longer read it. The relationship has to be expressed, not baked.
 */
function sheenCompensated(sampled: number, sheen: number, sheenTint: number): number {
  const maxChannel = Math.max((sheenTint >> 16) & 255, (sheenTint >> 8) & 255, sheenTint & 255) / 255;
  const darkening = SHEEN_ENERGY_COMPENSATION * sheen * maxChannel;
  const factor = 1 / (1 - darkening);
  const channel = (shift: number) =>
    Math.min(255, Math.round(((sampled >> shift) & 255) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * `MeshStandardMaterial` has NEITHER sheen NOR clearcoat, so until now every surface on this figure
 * — bare torso, bandage wraps, trousers, sash, blindfold — differed only in colour and roughness.
 * That is the whole reason cloth here read as painted plastic and skin read as matte cloth: the two
 * cues that separate them are not properties of the class that was being used.
 *
 * This upgrades to `MeshPhysicalMaterial` ONLY when a carrier is actually requested, so gold, sole
 * and anything else untouched keeps the cheaper class and byte-identical output.
 *
 * Full derivation of every number, cited to `three@0.169.0` source line by line:
 * `img2threejs/grimoire/build/threejs_skin_and_cloth_materials.md`.
 */
function mat(
  id: string,
  color: number,
  roughness: number,
  extras: {
    metalness?: number;
    emissive?: number;
    emissiveIntensity?: number;
    side?: THREE.Side;
    flatShading?: boolean;
    /**
     * Cloth's only woven cue in a code-only pipeline. `sheenColor` is NOT optional when `sheen > 0`:
     * three defaults it to 0x000000 and the sheen term is `sheenColor * (D * V)` — a multiply by
     * black — so `sheen` alone contributes exactly zero. The tint is the LIGHT's, not the cloth's.
     */
    sheen?: number;
    sheenColor?: number;
    /**
     * Charlie-distribution width. HIGH (0.7–1.0) for linen, canvas and coarse wraps: a broad soft
     * rim. Low values give a satin rim that, on sparse low-poly geometry, lands on a handful of
     * facets and reads as plastic.
     */
    sheenRoughness?: number;
    /** Skin's carrier: a broad soft dielectric highlight over a warm base. */
    clearcoat?: number;
    /** Never below 0.0525 — three clamps with `max(clearcoatRoughness, 0.0525)`, so smaller is a lie. */
    clearcoatRoughness?: number;
    /** Author `ior`, never `reflectivity`: they are one degree of freedom and `ior` is the physical one. */
    ior?: number;
  } = {},
): THREE.MeshStandardMaterial {
  const wantsPhysical =
    extras.sheen !== undefined || extras.clearcoat !== undefined || extras.ior !== undefined;
  // Applied HERE, once, rather than at each call site: every caller passes the colour it sampled off
  // the reference, and the only place that knows sheen is about to darken it is this function. Doing
  // it per-call-site is how five palette entries stopped being read at all.
  const sheenTint = extras.sheenColor ?? 0xffffff;
  const authoredColor =
    extras.sheen !== undefined && extras.sheen > 0
      ? sheenCompensated(color, extras.sheen, sheenTint)
      : color;
  const shared = {
    color: authoredColor,
    roughness,
    metalness: extras.metalness ?? 0,
    // Skin keeps the authored low-poly section silhouette but interpolates
    // normals across shared anatomy faces; cloth, hair, wraps, and gold retain
    // explicit faceting through the default true value.
    flatShading: extras.flatShading ?? true,
    side: extras.side ?? THREE.DoubleSide,
    emissive: extras.emissive ?? 0x000000,
    emissiveIntensity: extras.emissiveIntensity ?? 0,
  };
  const material: THREE.MeshStandardMaterial = wantsPhysical
    ? new THREE.MeshPhysicalMaterial({
        ...shared,
        ...(extras.sheen !== undefined
          ? {
              sheen: extras.sheen,
              // Defaulted to warm off-white rather than left to three's black: an omitted tint here
              // would silently make the sheen a no-op, which is the exact failure this wrapper exists
              // to make impossible.
              sheenColor: new THREE.Color(extras.sheenColor ?? 0xffffff),
              sheenRoughness: extras.sheenRoughness ?? 0.85,
            }
          : {}),
        ...(extras.clearcoat !== undefined
          ? {
              clearcoat: extras.clearcoat,
              clearcoatRoughness: Math.max(extras.clearcoatRoughness ?? 0.38, 0.0525),
            }
          : {}),
        ...(extras.ior !== undefined ? { ior: extras.ior } : {}),
      })
    : new THREE.MeshStandardMaterial(shared);
  material.name = `Lee Sin / ${id}`;
  material.userData.sculptMaterial = {
    id,
    roughness,
    metalness: extras.metalness ?? 0,
    procedural: true,
    referenceLightingBakedIntoAlbedo: false,
    // Recorded so a reviewer can tell a compensated albedo from a mis-sampled one. Enabling sheen
    // scales the diffuse term by `1 - 0.157 * max3(sheenColor)` (meshphysical.glsl.js:205), so any
    // cloth base below is authored BRIGHTER than its reference sample by exactly that factor.
    sheenBaseCompensated: extras.sheen !== undefined,
  };
  return material;
}

/** Closed low-poly tube whose axis is Y. Rings are ordered from bottom to top. */
function profileGeometry(
  rings: Array<[number, number, number, number?, number?]>,
  segs = 8,
): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  const offset = Math.PI / segs;
  for (const [y, rx, rz, ox = 0, oz = 0] of rings) {
    for (let i = 0; i < segs; i += 1) {
      const angle = (i / segs) * Math.PI * 2 + offset;
      vertices.push(ox + Math.cos(angle) * rx, y, oz + Math.sin(angle) * rz);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    const current = ring * segs;
    const next = (ring + 1) * segs;
    for (let i = 0; i < segs; i += 1) {
      const a = current + i;
      const b = current + ((i + 1) % segs);
      const c = next + i;
      const d = next + ((i + 1) % segs);
      if ((ring + i) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }
  const bottomCenter = vertices.length / 3;
  vertices.push(rings[0][3] ?? 0, rings[0][0], rings[0][4] ?? 0);
  const top = rings[rings.length - 1];
  const topCenter = vertices.length / 3;
  vertices.push(top[3] ?? 0, top[0], top[4] ?? 0);
  const last = (rings.length - 1) * segs;
  for (let i = 0; i < segs; i += 1) {
    const next = (i + 1) % segs;
    indices.push(bottomCenter, next, i);
    indices.push(topCenter, last + i, last + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

type AsymmetricSection = {
  y: number;
  rx: number;
  frontDepth: number;
  backDepth: number;
  centerZ?: number;
  centerX?: number;
};

/**
 * Closed semantic volume for anatomy that cannot use a circular tube.
 *
 * The front and back half-depths are authored independently so a skull, jaw,
 * neck, or muscle transition can have a real face plane and a shallower rear
 * plane.  This is deliberately a reusable section primitive rather than a
 * Lee-Sin-specific face patch; caps and longitudinal loops are generated in
 * the same pass, so the resulting volume has no open boundary.
 */
function asymmetricSectionGeometry(
  sections: AsymmetricSection[],
  segs = 10,
): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  const offset = Math.PI / segs;
  for (const section of sections) {
    for (let i = 0; i < segs; i += 1) {
      const angle = (i / segs) * Math.PI * 2 + offset;
      const radial = Math.sin(angle);
      const depth = radial >= 0 ? section.frontDepth : section.backDepth;
      vertices.push(
        (section.centerX ?? 0) + Math.cos(angle) * section.rx,
        section.y,
        (section.centerZ ?? 0) + radial * depth,
      );
    }
  }
  for (let ring = 0; ring < sections.length - 1; ring += 1) {
    const current = ring * segs;
    const next = (ring + 1) * segs;
    for (let i = 0; i < segs; i += 1) {
      const a = current + i;
      const b = current + ((i + 1) % segs);
      const c = next + i;
      const d = next + ((i + 1) % segs);
      if ((ring + i) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }
  const bottom = vertices.length / 3;
  vertices.push(sections[0].centerX ?? 0, sections[0].y, sections[0].centerZ ?? 0);
  const top = vertices.length / 3;
  const last = sections[sections.length - 1];
  vertices.push(last.centerX ?? 0, last.y, last.centerZ ?? 0);
  const lastRing = (sections.length - 1) * segs;
  for (let i = 0; i < segs; i += 1) {
    const next = (i + 1) % segs;
    indices.push(bottom, next, i);
    indices.push(top, lastRing + i, lastRing + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.anatomyRepresentation = {
    kind: 'closed-asymmetric-section-loft',
    watertight: true,
    sectionCount: sections.length,
    segmentsPerSection: segs,
    independentFrontBackDepth: true,
  };
  return geometry;
}

/**
 * Closed low-poly foot/instep wedge: heel is rear (-Z), toe points toward +Z.
 * `topLift` raises only the ankle-facing plane; the sole stays at the same
 * height so an anatomy bridge can be added without changing foot placement.
 */
function angularFootGeometry(width: number, height: number, rear: number, toe: number, topLift = 0): THREE.BufferGeometry {
  const halfWidth = width * 0.5;
  const topHalfWidth = halfWidth * 0.86;
  const halfHeight = height * 0.5;
  const bottomY = -halfHeight;
  const topY = halfHeight + topLift;
  const positions = [
    -halfWidth, bottomY, rear,
    halfWidth, bottomY, rear,
    halfWidth, bottomY, toe,
    -halfWidth, bottomY, toe,
    -topHalfWidth, topY, rear * 0.65,
    topHalfWidth, topY, rear * 0.65,
    topHalfWidth, topY, toe * 0.82,
    -topHalfWidth, topY, toe * 0.82,
  ];
  const indices = [
    0, 3, 2, 0, 2, 1,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.anatomyRepresentation = {
    kind: 'closed-angular-foot-wedge-with-instep-bridge',
    orientation: 'toe-positive-z',
    watertight: true,
    topLift,
    soleHeight: height,
  };
  return geometry;
}

/**
 * Closed low-poly open hand envelope.  The palm, thumb wedge, and finger
 * volumes are authored in one geometry so the hand is not a tapered arm tip
 * plus a pile of child boxes.  Small finger separations are intentional
 * silhouette channels; all pieces remain owned by the wrist pivot.
 */
function openHandGeometry(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const appendFrustum = (
    bottomLeft: number,
    bottomRight: number,
    topLeft: number,
    topRight: number,
    bottomY: number,
    topY: number,
    frontZ: number,
    backZ: number,
  ): void => {
    const base = positions.length / 3;
    positions.push(
      bottomLeft, bottomY, frontZ,
      bottomRight, bottomY, frontZ,
      topRight, topY, frontZ,
      topLeft, topY, frontZ,
      bottomLeft, bottomY, backZ,
      bottomRight, bottomY, backZ,
      topRight, topY, backZ,
      topLeft, topY, backZ,
    );
    indices.push(
      base, base + 1, base + 2, base, base + 2, base + 3,
      base + 5, base + 4, base + 7, base + 5, base + 7, base + 6,
      base, base + 4, base + 5, base, base + 5, base + 1,
      base + 1, base + 5, base + 6, base + 1, base + 6, base + 2,
      base + 2, base + 6, base + 7, base + 2, base + 7, base + 3,
      base + 3, base + 7, base + 4, base + 3, base + 4, base,
    );
  };

  // Palm: wider across the knuckles, tapered into the wrist.
  appendFrustum(-0.13, 0.13, -0.19, 0.19, -0.12, 0.19, 0.11, -0.10);

  // Four separated, slightly different-length finger wedges.
  const fingerCenters = [-0.135, -0.045, 0.045, 0.135];
  const fingerLengths = [0.14, 0.19, 0.20, 0.16];
  for (let i = 0; i < fingerCenters.length; i += 1) {
    const center = fingerCenters[i];
    const width = i === 1 || i === 2 ? 0.060 : 0.055;
    const bottomY = -0.12 - fingerLengths[i];
    appendFrustum(
      center - width * 0.5,
      center + width * 0.5,
      center - width * 0.43,
      center + width * 0.43,
      bottomY,
      -0.08,
      0.095,
      -0.075,
    );
  }

  // Thumb exits the lateral palm plane instead of being implied by the wrist.
  const thumbBottomA = side * 0.17;
  const thumbBottomB = side * 0.22;
  const thumbTopA = side * 0.145;
  const thumbTopB = side * 0.19;
  appendFrustum(
    Math.min(thumbBottomA, thumbBottomB),
    Math.max(thumbBottomA, thumbBottomB),
    Math.min(thumbTopA, thumbTopB),
    Math.max(thumbTopA, thumbTopB),
    -0.24,
    -0.02,
    0.10,
    -0.075,
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.anatomyRepresentation = {
    kind: 'closed-open-hand-envelope',
    watertightComponents: 6,
    palm: 'tapered-wedge',
    thumb: 'lateral-wedge',
    fingers: 'four-separated-tapered-wedges',
  };
  return geometry;
}

type UpperBodySkinBones = {
  chest: number;
  neck: number;
  shoulderL: number;
  elbowL: number;
  wristL: number;
  shoulderR: number;
  elbowR: number;
  wristR: number;
};

type SurfacePoint2D = { x: number; y: number };
type SurfaceGridRow = SurfacePoint2D[];
type SectionProfile = { y: number; width: number; depth: number };
type ArmProfile = { x: number; y: number; width: number; depth: number };

// Denser samples at the sternum, pectorals, and lateral chest make the
// anatomical planes come from the continuous surface rather than from decals.
// Keep the primary front planes broad enough to read as a continuous stylised
// anatomy surface.  The previous 7-column / 18-row grid produced a regular
// triangle quilt across the chest and abdomen; that was watertight, but it
// visually read as an extruded panel rather than a low-poly human torso.
const TORSO_COLUMN_RATIOS = [-1, -0.55, -0.06, 0.06, 0.55, 1] as const;

const PASS1_TORSO_SECTIONS: SectionProfile[] = [
  { y: -0.82, width: 0.56, depth: 0.28 },
  { y: -0.46, width: 0.64, depth: 0.36 },
  { y: -0.12, width: 0.72, depth: 0.44 },
  { y: 0.22, width: 0.86, depth: 0.52 },
  { y: 0.48, width: 0.92, depth: 0.56 },
  // The neck-base is a short trapezius bridge, not a cone that continues
  // behind the head.  Keep the public blueprint's broad clavicle shelf while
  // ending the torso close to the neck pivot so the neck remains visible.
  { y: 0.78, width: 0.90, depth: 0.50 },
  { y: 0.88, width: 0.78, depth: 0.42 },
  { y: 0.96, width: 0.62, depth: 0.35 },
  { y: 1.04, width: 0.46, depth: 0.29 },
  { y: 1.10, width: 0.32, depth: 0.24 },
  { y: 1.16, width: 0.23, depth: 0.20 },
  // Continue the same closed envelope into the cervical column.  These are
  // section stations, not a second capped neck primitive; the final pole is
  // only the head-attachment cap of the integrated surface.
  { y: 1.24, width: 0.21, depth: 0.18 },
  { y: 1.38, width: 0.24, depth: 0.20 },
  { y: 1.54, width: 0.21, depth: 0.18 },
  { y: 1.64, width: 0.15, depth: 0.14 },
];

const PASS1_ARM_PROFILE: ArmProfile[] = [
  { x: 0.91, y: 0.45, width: 0.33, depth: 0.35 },
  { x: 1.02, y: 0.50, width: 0.24, depth: 0.32 },
  { x: 1.19, y: 0.365, width: 0.29, depth: 0.30 },
  { x: 1.37, y: 0.09, width: 0.27, depth: 0.28 },
  { x: 1.60, y: -0.215, width: 0.25, depth: 0.26 },
  { x: 1.84, y: -0.57, width: 0.23, depth: 0.24 },
  { x: 2.14, y: -0.94, width: 0.21, depth: 0.23 },
  { x: 2.30, y: -1.275, width: 0.19, depth: 0.21 },
  { x: 2.375, y: -1.54, width: 0.14, depth: 0.18 },
];

// CharacterBlueprint face sections.  The jaw and cheek are one closed volume;
// the front depth is intentionally larger than the rear depth so the face is
// readable as anatomy rather than as a uniformly scaled cylinder.
const HEAD_ANATOMY_SECTIONS: AsymmetricSection[] = [
  // Jaw/chin are part of the skull envelope.  The lower stations are wider
  // through the cheek, then pinch into a real chin instead of being covered
  // by a second face-shaped primitive.
  { y: 0.00, rx: 0.165, frontDepth: 0.145, backDepth: 0.108, centerZ: 0.028 },
  { y: 0.06, rx: 0.215, frontDepth: 0.165, backDepth: 0.122, centerZ: 0.032 },
  { y: 0.14, rx: 0.260, frontDepth: 0.190, backDepth: 0.142, centerZ: 0.035 },
  { y: 0.25, rx: 0.295, frontDepth: 0.220, backDepth: 0.175, centerZ: 0.030 },
  { y: 0.42, rx: 0.31, frontDepth: 0.25, backDepth: 0.205, centerZ: 0.015 },
  { y: 0.62, rx: 0.31, frontDepth: 0.255, backDepth: 0.215, centerZ: 0.010 },
  { y: 0.80, rx: 0.285, frontDepth: 0.235, backDepth: 0.200, centerZ: 0.000 },
  { y: 0.96, rx: 0.23, frontDepth: 0.19, backDepth: 0.165, centerZ: -0.012 },
  { y: 1.08, rx: 0.16, frontDepth: 0.145, backDepth: 0.13, centerZ: -0.020 },
  { y: 1.16, rx: 0.11, frontDepth: 0.105, backDepth: 0.095, centerZ: -0.025 },
];

const NECK_ANATOMY_SECTIONS: AsymmetricSection[] = [
  { y: 0.00, rx: 0.27, frontDepth: 0.22, backDepth: 0.19, centerZ: 0.00 },
  { y: 0.16, rx: 0.33, frontDepth: 0.27, backDepth: 0.23, centerZ: 0.00 },
  { y: 0.38, rx: 0.31, frontDepth: 0.25, backDepth: 0.215, centerZ: 0.00 },
  { y: 0.58, rx: 0.27, frontDepth: 0.22, backDepth: 0.19, centerZ: 0.00 },
  { y: 0.74, rx: 0.25, frontDepth: 0.21, backDepth: 0.18, centerZ: 0.00 },
];

type CharacterBlueprint = {
  stature: number;
  headUnits: number;
  landmarks: Record<string, number>;
  proportions: Record<string, number>;
  bodyType: string;
  silhouette: {
    reference: string;
    aspect: [number, number];
    views: readonly string[];
  };
  crossSections: {
    torso: readonly SectionProfile[];
    arm: readonly ArmProfile[];
    head: readonly AsymmetricSection[];
    neck: readonly AsymmetricSection[];
  };
  poseEstimate: {
    rest: string;
    arms: string;
    legs: string;
  };
  visibility: Record<string, string>;
  confidence: Record<string, number>;
};

/**
 * CharacterBlueprint is the inspectable bridge between reference analysis and
 * generated geometry.  It intentionally points at reusable section data and
 * named pivot measurements rather than baking a second Lee-Sin mesh recipe.
 */
const LEE_SIN_BLUEPRINT: CharacterBlueprint = {
  stature: 1,
  headUnits: 7,
  landmarks: {
    headTop: 1.00,
    chin: 0.88,
    neckBase: 0.79,
    clavicle: 0.75,
    sternum: 0.69,
    ribCageBottom: 0.57,
    waist: 0.52,
    pelvis: 0.45,
    crotch: 0.39,
    knee: 0.18,
    ankle: 0.04,
    toe: 0.00,
  },
  proportions: {
    torsoWidthScale: PASS1_PROPORTIONS.torsoWidthScale,
    shoulderWidthScale: PASS1_PROPORTIONS.shoulderWidthScale,
    torsoDepthScale: PASS1_PROPORTIONS.torsoDepthScale,
    shoulderX: PASS1_PROPORTIONS.shoulderX,
    elbowX: PASS1_PROPORTIONS.elbowX,
    wristX: PASS1_PROPORTIONS.wristX,
    wristY: PASS1_PROPORTIONS.wristY,
    hipX: PASS1_PROPORTIONS.hipX,
    kneeY: PASS1_PROPORTIONS.kneeY,
    ankleY: PASS1_PROPORTIONS.ankleY,
  },
  bodyType: 'lean-athletic-low-poly-martial-artist',
  silhouette: {
    reference: 'public/references/lee-sin.jpg',
    aspect: [1408, 768],
    views: ['front-primary', 'three-quarter-left', 'three-quarter-right', 'profile-right', 'rear'],
  },
  crossSections: {
    torso: PASS1_TORSO_SECTIONS,
    arm: PASS1_ARM_PROFILE,
    head: HEAD_ANATOMY_SECTIONS,
    neck: NECK_ANATOMY_SECTIONS,
  },
  poseEstimate: {
    rest: 'relaxed reference pose with arms down and palms open',
    arms: 'shoulder-down diagonal with elbow and wrist landmarks preserved',
    legs: 'parallel relaxed stance with visible calves and ankle wraps',
  },
  visibility: {
    front: 'admitted-primary',
    side: 'inferred-from-turnaround-board',
    back: 'inferred-from-turnaround-board',
    hidden: 'rear scalp, belt wrap, sole tread remain inferred',
  },
  confidence: {
    silhouette: 0.86,
    proportions: 0.82,
    depth: 0.62,
    hiddenSide: 0.45,
  },
};

function interpolateSection(sections: SectionProfile[], y: number): SectionProfile {
  const scaleWidth = (section: SectionProfile): SectionProfile => ({
    ...section,
    width: section.width * torsoWidthScaleAt(section.y),
  });
  if (y <= sections[0].y) return scaleWidth(sections[0]);
  if (y >= sections[sections.length - 1].y) return scaleWidth(sections[sections.length - 1]);
  for (let i = 0; i < sections.length - 1; i += 1) {
    const a = sections[i];
    const b = sections[i + 1];
    if (y <= b.y) {
      const t = THREE.MathUtils.smoothstep(y, a.y, b.y);
      return {
        y,
        width: THREE.MathUtils.lerp(a.width, b.width, t) * torsoWidthScaleAt(y),
        depth: THREE.MathUtils.lerp(a.depth, b.depth, t),
      };
    }
  }
  return sections[sections.length - 1];
}

/**
 * Reference pants are relaxed through the thigh, then tighten toward the
 * knee-level hem.  Keeping this as a bounded profile function makes the
 * lower-body volume editable without turning the garment into a uniform
 * balloon or changing the pelvis waistband contour.
 */
function straightPantsWidthScaleAt(y: number): number {
  if (y <= -2.42) return THREE.MathUtils.lerp(1.03, 1.08, THREE.MathUtils.clamp((y + 2.64) / 0.22, 0, 1));
  // The reference keeps a little more relaxed cloth volume through the
  // thigh-to-hem run.  This is a bounded width correction, not a spherical
  // bulge: the section still tapers at the waistband and knee hem.
  if (y <= -0.56) return 1.16;
  if (y <= -0.18) return THREE.MathUtils.lerp(1.08, 1.00, THREE.MathUtils.clamp((-y - 0.18) / 0.38, 0, 1));
  return 1.00;
}

function interpolateArmProfile(t: number): ArmProfile {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  const scaled = clamped * (PASS1_ARM_PROFILE.length - 1);
  const index = Math.min(PASS1_ARM_PROFILE.length - 2, Math.floor(scaled));
  const localT = scaled - index;
  const a = PASS1_ARM_PROFILE[index];
  const b = PASS1_ARM_PROFILE[index + 1];
  return {
    x: THREE.MathUtils.lerp(a.x, b.x, localT),
    y: THREE.MathUtils.lerp(a.y, b.y, localT),
    width: THREE.MathUtils.lerp(a.width, b.width, localT),
    depth: THREE.MathUtils.lerp(a.depth, b.depth, localT),
  };
}

function armDistanceAt(x: number, y: number): { distance: number; t: number; profile: ArmProfile } {
  const ax = Math.abs(x);
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestT = 0;
  for (let i = 0; i < PASS1_ARM_PROFILE.length - 1; i += 1) {
    const a = PASS1_ARM_PROFILE[i];
    const b = PASS1_ARM_PROFILE[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const projection = lengthSq > 1e-8
      ? THREE.MathUtils.clamp(((ax - a.x) * dx + (y - a.y) * dy) / lengthSq, 0, 1)
      : 0;
    const px = a.x + dx * projection;
    const py = a.y + dy * projection;
    const distance = Math.hypot(ax - px, y - py);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = (i + projection) / (PASS1_ARM_PROFILE.length - 1);
    }
  }
  return { distance: bestDistance, t: bestT, profile: interpolateArmProfile(bestT) };
}

function torsoFrontDepth(x: number, y: number): number {
  const section = interpolateSection(PASS1_TORSO_SECTIONS, y);
  const radial = THREE.MathUtils.clamp(Math.abs(x) / Math.max(section.width, 1e-4), 0, 1);
  const edgeRound = Math.sqrt(Math.max(0.08, 1 - radial * radial));
  // Broad continuous depth fields make the rib cage/pectorals read as one
  // athletic torso in profile.  These are scalar deformations of the same
  // closed envelope, not secondary muscle primitives.
  const pectoral = Math.exp(-(((Math.abs(x) - 0.34) ** 2) / 0.16 + ((y - 0.42) ** 2) / 0.22)) * 0.245;
  const upperPectoral = Math.exp(-(((Math.abs(x) - 0.43) ** 2) / 0.22 + ((y - 0.68) ** 2) / 0.22)) * 0.115;
  const claviclePlane = Math.exp(-(((Math.abs(x) - 0.34) ** 2) / 0.25 + ((y - 0.78) ** 2) / 0.085)) * 0.042;
  const sternum = Math.exp(-((x * x) / 0.050 + ((y - 0.40) ** 2) / 0.34)) * 0.052;
  const ribPlane = Math.exp(-((x * x) / 0.30 + ((y - 0.10) ** 2) / 0.34)) * 0.060;
  const abdomenPlane = Math.exp(-((x * x) / 0.22 + ((y + 0.04) ** 2) / 0.34)) * 0.055;
  return (section.depth * (0.82 + edgeRound * 0.18)
    + pectoral + upperPectoral + claviclePlane + ribPlane + abdomenPlane - sternum)
    * PASS1_PROPORTIONS.torsoDepthScale;
}

function surfaceDepthAt(x: number, y: number): { front: number; back: number } {
  const torsoSection = interpolateSection(PASS1_TORSO_SECTIONS, y);
  const torsoEdge = THREE.MathUtils.smoothstep(
    Math.abs(x) - torsoSection.width + 0.06,
    -0.10,
    0.28,
  );
  const torsoWeight = 1 - torsoEdge;
  const arm = armDistanceAt(x, y);
  const armWeight = 1 - THREE.MathUtils.smoothstep(
    arm.distance,
    arm.profile.width * 0.45,
    arm.profile.width * 1.45,
  );
  // Non-monotonic anatomical depth: deltoid/upper-arm fullness, a small
  // elbow relief, then a second forearm mass before the wrist taper.  The
  // fields are weighted by distance to the arm ribbon, so torso depth remains
  // independent and the same closed surface carries the transition.
  const bicepsBulge = Math.exp(-(((arm.t - 0.30) ** 2) / 0.032)) * 0.052;
  const forearmBulge = Math.exp(-(((arm.t - 0.72) ** 2) / 0.042)) * 0.043;
  const armMuscleDepth = (bicepsBulge + forearmBulge) * THREE.MathUtils.clamp(armWeight, 0, 1);
  const armFront = arm.profile.depth * (0.84 + (1 - THREE.MathUtils.clamp(arm.distance / Math.max(arm.profile.width, 1e-4), 0, 1)) * 0.16)
    + armMuscleDepth;
  const torsoFront = torsoFrontDepth(x, y);
  const front = THREE.MathUtils.lerp(armFront, torsoFront, torsoWeight * (1 - armWeight * 0.40));
  const radial = THREE.MathUtils.clamp(Math.abs(x) / Math.max(torsoSection.width, 1e-4), 0, 1);
  const rearEdgeRound = Math.sqrt(Math.max(0.08, 1 - radial * radial));
  const scapular = Math.exp(-(((Math.abs(x) - 0.40) ** 2) / 0.22 + ((y - 0.55) ** 2) / 0.38)) * 0.105;
  const latPlane = Math.exp(-(((Math.abs(x) - 0.56) ** 2) / 0.18 + ((y - 0.10) ** 2) / 0.64)) * 0.060;
  const lowerBackPlane = Math.exp(-((x * x) / 0.25 + ((y + 0.34) ** 2) / 0.30)) * 0.028;
  const torsoBack = (torsoSection.depth * (0.82 + rearEdgeRound * 0.18)
    + scapular + latPlane + lowerBackPlane) * PASS1_PROPORTIONS.torsoDepthScale;
  const armBack = arm.profile.depth * (0.78 + (1 - THREE.MathUtils.clamp(arm.distance / Math.max(arm.profile.width, 1e-4), 0, 1)) * 0.22)
    + armMuscleDepth * 0.62;
  return { back: -THREE.MathUtils.lerp(armBack, torsoBack, torsoWeight * (1 - armWeight * 0.34)), front };
}

function skinWeightsAt(x: number, y: number, bones: UpperBodySkinBones): { ids: number[]; weights: number[] } {
  const ax = Math.abs(x);
  const torsoSection = interpolateSection(PASS1_TORSO_SECTIONS, y);
  const arm = armDistanceAt(x, y);
  const sign = x >= 0 ? 1 : -1;
  const shoulder = sign > 0 ? bones.shoulderL : bones.shoulderR;
  const elbow = sign > 0 ? bones.elbowL : bones.elbowR;
  const wrist = sign > 0 ? bones.wristL : bones.wristR;
  if (y > 1.15) {
    return { ids: [bones.neck], weights: [1] };
  }
  if (ax < torsoSection.width * 0.82) {
    return { ids: [bones.chest], weights: [1] };
  }
  const branchWeight = THREE.MathUtils.smoothstep(torsoSection.width * 0.70, torsoSection.width + 0.18, ax);
  if (arm.distance > arm.profile.width * 1.55 && branchWeight < 0.2) {
    return { ids: [bones.chest], weights: [1] };
  }
  const t = arm.t;
  if (t < 0.34) {
    const elbowWeight = THREE.MathUtils.smoothstep(t, 0.16, 0.42) * 0.62;
    return {
      ids: [bones.chest, shoulder, elbow],
      weights: [(1 - branchWeight) * (1 - elbowWeight), branchWeight * (1 - elbowWeight), branchWeight * elbowWeight],
    };
  }
  const wristWeight = THREE.MathUtils.smoothstep(t, 0.67, 0.98) * 0.72;
  return {
    ids: [shoulder, elbow, wrist],
    weights: [0.10 * (1 - wristWeight), 1 - 0.10 * (1 - wristWeight) - wristWeight, wristWeight],
  };
}

function connectedUpperBodyContourLoftGeometry(bones: UpperBodySkinBones): THREE.BufferGeometry {
  const torsoGridRows: SurfaceGridRow[] = [
    { y: -0.82, width: 0.56 },
    { y: -0.58, width: 0.60 },
    { y: -0.34, width: 0.67 },
    { y: -0.12, width: 0.72 },
    // Broad pectoral/clavicle shelf; the taper still begins below the rib
    // plane, so this does not reintroduce the previous barrel torso.
    { y: 0.12, width: 0.92 },
    // The reference's upper pectoral shelf is wider than the shoulder-root
    // interpolation immediately below it.  Give this station its own broad
    // rib-cage contour so the chest does not collapse into a narrow triangle.
    { y: 0.28, width: 1.02 },
    { y: 0.45, width: 0.91 },
    { y: 0.62, width: 0.905 },
    { y: 0.78, width: 0.90 },
    // Raise the clavicle/shoulder apex toward the jaw line.  This shortens
    // the visible neck without moving the head or using a camera offset.
    { y: 0.90, width: 0.90 },
    // Match the cervical/trapezius station to the measured front silhouette.
    // The previous 0.78 contour was 26 px wide where the reference is 21 px,
    // and contradicted the narrower anatomical depth section at the same Y.
    { y: 1.04, width: 0.63 },
    { y: 1.16, width: 0.46 },
    { y: 1.24, width: 0.23 },
  ].map(({ y, width }) => TORSO_COLUMN_RATIOS.map((ratio) => ({
    x: width * torsoWidthScaleAt(y) * ratio,
    y,
  })));

  const torsoOuter = (row: SurfaceGridRow): SurfacePoint2D => row[row.length - 1];
  const rowIndexAt = (y: number): number => torsoGridRows.findIndex((row) => Math.abs(row[0].y - y) < 1e-6);
  const armInnerRootRow = rowIndexAt(0.12);
  const armOuterRootRow = rowIndexAt(0.90);

  const armInner: SurfacePoint2D[] = [
    torsoOuter(torsoGridRows[armInnerRootRow]),
    { x: 1.02, y: 0.25 },
    { x: 1.18, y: 0.05 },
    { x: 1.38, y: -0.32 },
    { x: 1.76, y: -0.68 },
    { x: 2.01, y: -1.06 },
    { x: 2.15, y: -1.38 },
    { x: 2.27, y: -1.55 },
    { x: 2.36, y: -1.60 },
  ];
  const armOuter: SurfacePoint2D[] = [
    torsoOuter(torsoGridRows[armOuterRootRow]),
    { x: 0.94, y: 0.84 },
    { x: 1.04, y: 0.68 },
    { x: 1.20, y: 0.50 },
    { x: 1.42, y: 0.25 },
    { x: 1.70, y: -0.08 },
    { x: 2.07, y: -0.50 },
    { x: 2.34, y: -1.00 },
    { x: 2.46, y: -1.48 },
  ];
  // The root row is the six-ring shoulder seam. Keep the same column count so
  // every arm row is indexed into that shared watertight boundary.
  const armRibbonColumns = [0, 0.20, 0.40, 0.60, 0.80, 1];
  // Keep every torso ring in the shared shoulder seam.  Dropping the .36 ring
  // would leave a boundary edge between the torso strip and arm ribbon.
  const shoulderSeamRows = torsoGridRows.slice(armInnerRootRow, armOuterRootRow + 1);
  const armRows: SurfaceGridRow[] = [shoulderSeamRows.map(torsoOuter)];
  for (let row = 1; row < armInner.length; row += 1) {
    // Non-monotonic anatomy: deltoid/upper-arm fullness, elbow narrowing,
    // forearm re-expansion, then wrist taper. Expansion is around the row
    // centre, so the shared shoulder seam remains unchanged.
    // Keep the arm centerline and named joints fixed; only expand the
    // cross-section around it.  The admitted plate carries more athletic
    // upper-arm/forearm volume than the previous narrow ribbon, especially
    // through the elbow-to-wrist run.
    const fullness = row <= 2 ? 1.20 : row <= 4 ? 1.22 : 1.25;
    const centerX = (armInner[row].x + armOuter[row].x) * 0.5;
    const centerY = (armInner[row].y + armOuter[row].y) * 0.5;
    armRows.push(armRibbonColumns.map((ratio) => ({
      x: centerX + (THREE.MathUtils.lerp(armInner[row].x, armOuter[row].x, ratio) - centerX) * fullness,
      y: centerY + (THREE.MathUtils.lerp(armInner[row].y, armOuter[row].y, ratio) - centerY) * fullness,
    })));
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const regionIds: number[] = [];
  const pointMap = new Map<string, { front: number; back: number }>();
  const indices: number[] = [];
  const pointKey = (point: SurfacePoint2D): string => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
  const pushVertex = (point: SurfacePoint2D, z: number, regionId: number): number => {
    const index = positions.length / 3;
    positions.push(point.x, point.y, z);
    uvs.push(0.5 + point.x / 5.0, THREE.MathUtils.clamp((point.y + 1.7) / 3.4, 0, 1));
    const influence = skinWeightsAt(point.x, point.y, bones);
    const normalized = influence.weights.reduce((sum, weight) => sum + weight, 0) || 1;
    skinIndices.push(influence.ids[0] ?? 0, influence.ids[1] ?? 0, influence.ids[2] ?? 0, 0);
    skinWeights.push(
      (influence.weights[0] ?? 0) / normalized,
      (influence.weights[1] ?? 0) / normalized,
      (influence.weights[2] ?? 0) / normalized,
      0,
    );
    regionIds.push(regionId);
    return index;
  };
  const addSurfacePoint = (point: SurfacePoint2D, regionId: number): { front: number; back: number } => {
    const key = pointKey(point);
    const existing = pointMap.get(key);
    if (existing) return existing;
    const depth = surfaceDepthAt(point.x, point.y);
    const created = {
      front: pushVertex(point, depth.front, regionId),
      back: pushVertex(point, depth.back, regionId + 1),
    };
    pointMap.set(key, created);
    return created;
  };
  const addTriangle = (a: SurfacePoint2D, b: SurfacePoint2D, c: SurfacePoint2D, regionId: number): void => {
    const pa = addSurfacePoint(a, regionId);
    const pb = addSurfacePoint(b, regionId);
    const pc = addSurfacePoint(c, regionId);
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area >= 0) {
      indices.push(pa.front, pb.front, pc.front, pc.back, pb.back, pa.back);
    } else {
      indices.push(pa.front, pc.front, pb.front, pb.back, pc.back, pa.back);
    }
  };
  const addGridStrip = (rows: SurfaceGridRow[], regionId: number): void => {
    for (let row = 0; row < rows.length - 1; row += 1) {
      const lower = rows[row];
      const upper = rows[row + 1];
      for (let column = 0; column < lower.length - 1; column += 1) {
        const a = lower[column];
        const b = lower[column + 1];
        const c = upper[column];
        const d = upper[column + 1];
        addTriangle(a, b, c, regionId);
        addTriangle(b, d, c, regionId);
      }
    }
  };
  const mirrorRows = (rows: SurfaceGridRow[]): SurfaceGridRow[] => rows.map((row) => row.map((point) => ({ x: -point.x, y: point.y })));
  addGridStrip(torsoGridRows, 1);
  addGridStrip(armRows, 3);
  addGridStrip(mirrorRows(armRows), 3);

  const apex: SurfacePoint2D = { x: 0, y: 1.68 };
  const topRow = torsoGridRows[torsoGridRows.length - 1];
  for (let column = 0; column < topRow.length - 1; column += 1) {
    addTriangle(topRow[column], topRow[column + 1], apex, 1);
  }

  const positiveBoundary: SurfacePoint2D[] = [
    ...torsoGridRows[0].slice(Math.floor(torsoGridRows[0].length / 2)),
    ...torsoGridRows.slice(1, armInnerRootRow + 1).map(torsoOuter),
    ...armRows.slice(1).map((row) => row[0]),
    ...armRows[armRows.length - 1].slice(1),
    ...armRows.slice(0, -1).reverse().map((row) => row[row.length - 1]),
    ...torsoGridRows.slice(armOuterRootRow + 1).map(torsoOuter),
    apex,
  ];
  const globalBoundary = positiveBoundary.concat(
    positiveBoundary.slice(1, -1).reverse().map((point) => ({ x: -point.x, y: point.y })),
  );
  const sideBandMap = new Map<string, number>();
  const sideBandFractions = [0.10, 0.24, 0.40, 0.58, 0.76, 0.90] as const;
  // Round the lateral cross-section instead of extruding a nearly planar
  // side wall.  The middle bands stand proud of the front/back rim and then
  // return toward the rear rim, so the profile reads as rib-cage volume while
  // remaining part of the same indexed surface.
  const sideBandScales = [0.05, 0.42, 0.78, 1.00, 0.80, 0.38] as const;
  const sideBand = (point: SurfacePoint2D, band: number, regionId: number): number => {
    const fraction = sideBandFractions[band];
    const key = `${pointKey(point)}:${band}`;
    const existing = sideBandMap.get(key);
    if (existing !== undefined) return existing;
    const depth = surfaceDepthAt(point.x, point.y);
    const torsoSection = interpolateSection(PASS1_TORSO_SECTIONS, point.y);
    const arm = armDistanceAt(point.x, point.y);
    const isArmBoundary = arm.distance < arm.profile.width * 1.5
      && Math.abs(point.x) > torsoSection.width * 0.82;
    const lateralBulge = (isArmBoundary ? arm.profile.depth : torsoSection.depth) * 0.36;
    const x = point.x + Math.sign(point.x) * THREE.MathUtils.clamp(
      lateralBulge * sideBandScales[band],
      0.008,
      0.16,
    );
    const z = THREE.MathUtils.lerp(depth.front, depth.back, fraction);
    const index = pushVertex({ x, y: point.y }, z, regionId + 2 + band);
    sideBandMap.set(key, index);
    return index;
  };
  for (let i = 0; i < globalBoundary.length; i += 1) {
    const current = globalBoundary[i];
    const next = globalBoundary[(i + 1) % globalBoundary.length];
    const a = addSurfacePoint(current, 1);
    const b = addSurfacePoint(next, 1);
    const currentBands = sideBandFractions.map((_, band) => sideBand(current, band, 1));
    const nextBands = sideBandFractions.map((_, band) => sideBand(next, band, 1));
    // Multiple depth bands turn the closed boundary into an anatomical
    // prismatic section instead of one large side slab: front -> lateral
    // shoulder/chest planes -> back. The same indexed bands are used on arms.
    const leftEdge = [a.front, ...currentBands, a.back];
    const rightEdge = [b.front, ...nextBands, b.back];
    for (let band = 0; band < leftEdge.length - 1; band += 1) {
      indices.push(
        leftEdge[band], leftEdge[band + 1], rightEdge[band],
        rightEdge[band], leftEdge[band + 1], rightEdge[band + 1],
      );
    }
  }
  // Close the lower torso contour with the existing front/back row vertices.
  // The side-band loop leaves two triangular openings between columns 1..3;
  // adding a transverse quad strip here overlaps already closed outer edges
  // and creates non-manifold counts, so cap the observed holes explicitly.
  const bottomRow = torsoGridRows[0];
  const bottomA = addSurfacePoint(bottomRow[1], 1);
  const bottomB = addSurfacePoint(bottomRow[2], 1);
  const bottomC = addSurfacePoint(bottomRow[3], 1);
  indices.push(
    bottomA.front, bottomB.front, bottomC.front,
    bottomA.back, bottomC.back, bottomB.back,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute('semanticRegion', new THREE.Uint16BufferAttribute(regionIds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.anatomyRepresentation = {
    kind: 'continuous-profiled-section-grid',
    watertight: true,
    topology: 'structured torso rows plus stitched arm ribbon rows sharing root seam vertices',
    visibleCaps: false,
    semanticRegions: ['neck-base', 'trapezius', 'clavicle', 'pectorals', 'waist', 'deltoids', 'upper-arms', 'elbows', 'forearms', 'wrists'],
    sections: {
      torso: PASS1_TORSO_SECTIONS,
      arm: PASS1_ARM_PROFILE,
      shoulder: 'shared contour transition; no detached cap',
    },
    surfaceRefinement: {
      passes: 2,
      torsoRows: torsoGridRows.length,
      armRows: armRows.length,
      columnsPerRow: torsoGridRows[0].length,
      armColumnsPerRow: armRows[0].length,
      frontRelief: '5-column sternum/pectoral cross-sections with clavicle, rib, and abdomen depth fields',
      backRelief: 'scapular, lat, and lower-back depth fields',
      boundaryStitch: 'outer silhouette uses front-lateral-back ridge; torso-to-arm root seam shares indexed vertices',
      sideCrossSection: 'eight-station rounded lateral section, no single rectangular side wall',
      armFullness: 'root-preserving non-monotonic ribbon expansion: 1.20x deltoid, 1.16x upper-arm, 1.12x forearm',
    },
    pass: 'blockout-silhouette-v2',
  };
  return geometry;
}

type SurfaceMarkPath = readonly SurfacePoint2D[];

type SurfaceMarkZone = 'torso' | 'upper-arm' | 'forearm';

function surfaceMarkZoneAt(x: number, y: number): SurfaceMarkZone {
  const arm = armDistanceAt(x, y);
  const armLimit = arm.profile.width * 1.35;
  if (arm.distance > armLimit) return 'torso';
  return arm.t < 0.44 ? 'upper-arm' : 'forearm';
}

/**
 * Front-surface normal for an anchored pigment point.  Marks use the same
 * analytic depth field as the continuous body envelope; finite differences
 * provide a reusable tangent-frame approximation without introducing a
 * second mesh or a camera-facing decal.  The normal is authored in the torso
 * bind space, then the shared skin weights carry it through the existing
 * shoulder/elbow/wrist bones.
 */
function surfaceFrontNormalAt(x: number, y: number): Vec3 {
  const epsilon = 0.002;
  const dzdx = (
    surfaceDepthAt(x + epsilon, y).front - surfaceDepthAt(x - epsilon, y).front
  ) / (2 * epsilon);
  const dzdy = (
    surfaceDepthAt(x, y + epsilon).front - surfaceDepthAt(x, y - epsilon).front
  ) / (2 * epsilon);
  const normal = new THREE.Vector3(-dzdx, -dzdy, 1).normalize();
  return [normal.x, normal.y, normal.z];
}

/**
 * Build pigment as a closed, skin-bound vector ribbon volume.  Both faces and
 * the narrow perimeter are sampled from the same section-depth function as
 * the body and carry the same skin weights, so this is not an open decal or
 * an unparented floating panel.  The explicit anchor attribute keeps the
 * source (u,v) surface binding inspectable for later mark deformation.
 */
function attachedSurfaceMarkGeometry(
  paths: readonly SurfaceMarkPath[],
  width: number,
  bones: UpperBodySkinBones,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const surfaceAnchors: number[] = [];
  const surfaceNormals: number[] = [];
  const surfaceZones: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const regionIds: number[] = [];
  const indices: number[] = [];
  // Pigment must sit on the analytic skin surface, not read as a raised
  // appliqué.  Keep a tiny positive epsilon for depth stability while the
  // front face remains flush to the same surface sampled by the body mesh.
  const normalOffset = 0.0035;
  const thickness = 0.0015;

  const addVertex = (point: SurfacePoint2D, offset: number): number => {
    const index = positions.length / 3;
    const surface = surfaceDepthAt(point.x, point.y);
    const influence = skinWeightsAt(point.x, point.y, bones);
    const normal = surfaceFrontNormalAt(point.x, point.y);
    const zone = surfaceMarkZoneAt(point.x, point.y);
    const total = influence.weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const u = 0.5 + point.x / 5.0;
    const v = THREE.MathUtils.clamp((point.y + 1.7) / 3.4, 0, 1);
    positions.push(
      point.x + normal[0] * offset,
      point.y + normal[1] * offset,
      surface.front + normal[2] * offset,
    );
    uvs.push(u, v);
    surfaceAnchors.push(u, v);
    surfaceNormals.push(normal[0], normal[1], normal[2]);
    surfaceZones.push(zone === 'torso' ? 0 : zone === 'upper-arm' ? 1 : 2);
    skinIndices.push(influence.ids[0] ?? 0, influence.ids[1] ?? 0, influence.ids[2] ?? 0, 0);
    skinWeights.push(
      (influence.weights[0] ?? 0) / total,
      (influence.weights[1] ?? 0) / total,
      (influence.weights[2] ?? 0) / total,
      0,
    );
    regionIds.push(100);
    return index;
  };

  for (const path of paths) {
    if (path.length < 2) continue;
    const frontLeft: number[] = [];
    const frontRight: number[] = [];
    const backLeft: number[] = [];
    const backRight: number[] = [];
    for (let i = 0; i < path.length; i += 1) {
      const point = path[i];
      const previous = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      const tangentX = next.x - previous.x;
      const tangentY = next.y - previous.y;
      const length = Math.hypot(tangentX, tangentY) || 1;
      const normalX = -tangentY / length;
      const normalY = tangentX / length;
      const leftPoint = { x: point.x + normalX * width * 0.5, y: point.y + normalY * width * 0.5 };
      const rightPoint = { x: point.x - normalX * width * 0.5, y: point.y - normalY * width * 0.5 };
      frontLeft.push(addVertex(leftPoint, normalOffset));
      frontRight.push(addVertex(rightPoint, normalOffset));
      backLeft.push(addVertex(leftPoint, normalOffset - thickness));
      backRight.push(addVertex(rightPoint, normalOffset - thickness));
    }
    for (let i = 0; i < path.length - 1; i += 1) {
      const next = i + 1;
      // Front and back skins.
      indices.push(
        frontLeft[i], frontRight[i], frontLeft[next],
        frontRight[i], frontRight[next], frontLeft[next],
        backLeft[i], backLeft[next], backRight[i],
        backRight[i], backLeft[next], backRight[next],
      );
      // Side walls close the ribbon along both long edges.
      indices.push(
        frontLeft[i], frontLeft[next], backLeft[i],
        backLeft[i], frontLeft[next], backLeft[next],
        frontRight[i], backRight[i], frontRight[next],
        backRight[i], backRight[next], frontRight[next],
      );
    }
    // End caps close each independent stroke, keeping the mark itself
    // manifold even when a future topology audit includes surface meshes.
    const last = path.length - 1;
    indices.push(
      frontLeft[0], backLeft[0], frontRight[0],
      frontRight[0], backLeft[0], backRight[0],
      frontLeft[last], frontRight[last], backLeft[last],
      frontRight[last], backRight[last], backLeft[last],
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('surfaceAnchor', new THREE.Float32BufferAttribute(surfaceAnchors, 2));
  geometry.setAttribute('surfaceNormal', new THREE.Float32BufferAttribute(surfaceNormals, 3));
  geometry.setAttribute('surfaceZone', new THREE.Uint8BufferAttribute(surfaceZones, 1));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute('semanticRegion', new THREE.Uint16BufferAttribute(regionIds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.surfaceMarkRepresentation = {
    classification: 'P',
    kind: 'closed-skin-bound-vector-mark-volume',
    pathCount: paths.length,
    width,
    normalOffset,
    thickness,
    closed: true,
    rigidParent: 'torso',
    surfaceAnchor: 'torso section-depth uv + barycentric-ready source coordinates',
    tangentFrame: 'finite-difference front-surface normal in shared bind space',
    jointBinding: 'same skinIndex/skinWeight attributes as the continuous torso-arm envelope',
    zones: { torso: 0, upperArm: 1, forearm: 2 },
    normalOffsetSpace: 'surface-normal',
    sharesBodySkinWeights: true,
    floatingPanel: false,
  };
  return geometry;
}

/**
 * Watertight Pass-1 body envelope for a relaxed humanoid pose.
 *
 * The outline is a single concave loop: waist -> armpit -> inner arm -> wrist
 * -> outer arm -> shoulder -> trapezius -> neck, mirrored across the body.
 * Front/back depths vary by semantic region, so this is a closed faceted
 * volume rather than a camera-facing panel.  Skin attributes let the same
 * manifold follow the existing shoulder and elbow pivots without splitting
 * the visible skin into capped torso/arm primitives.
 */
function connectedUpperBodyGeometry(bones: UpperBodySkinBones): THREE.BufferGeometry {
  return connectedUpperBodyContourLoftGeometry(bones);
}

function ellipsoid(rx: number, ry: number, rz: number, detail = 1): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, Math.max(0, Math.round(detail)));
  geometry.scale(rx, ry, rz);
  geometry.computeVertexNormals();
  return geometry;
}

function panel(points: Array<[number, number]>, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

/** Closed fitted garment shell for the diagonal sash.  The strip follows the
 * waist ellipse through front, side, and rear instead of ending as a camera
 * facing panel at the hip.
 */
function diagonalSashShellGeometry(segments = 20): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const outerX = 0.58;
  const outerZ = 0.36;
  const innerX = 0.53;
  const innerZ = 0.31;
  const halfHeight = 0.08;
  const baseY = -0.08;
  const pushRing = (x: number, z: number, y: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    return index;
  };
  for (let i = 0; i < segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const outerXPoint = outerX * cos;
    const outerZPoint = outerZ * sin;
    const innerXPoint = innerX * cos;
    const innerZPoint = innerZ * sin;
    // Higher on the character's left, lower on the opposite hip: a genuine
    // diagonal band rather than two arbitrary front triangles.
    const outerY = baseY - (outerXPoint / outerX) * 0.12;
    const innerY = baseY - (innerXPoint / innerX) * 0.12;
    pushRing(outerXPoint, outerZPoint, outerY + halfHeight);
    pushRing(outerXPoint, outerZPoint, outerY - halfHeight);
    pushRing(innerXPoint, innerZPoint, innerY + halfHeight);
    pushRing(innerXPoint, innerZPoint, innerY - halfHeight);
  }
  for (let i = 0; i < segments; i += 1) {
    const next = ((i + 1) % segments) * 4;
    const current = i * 4;
    const outerTop = current;
    const outerBottom = current + 1;
    const innerTop = current + 2;
    const innerBottom = current + 3;
    const nextOuterTop = next;
    const nextOuterBottom = next + 1;
    const nextInnerTop = next + 2;
    const nextInnerBottom = next + 3;
    indices.push(
      outerTop, outerBottom, nextOuterTop,
      outerBottom, nextOuterBottom, nextOuterTop,
      nextInnerTop, innerTop, innerBottom,
      nextInnerTop, innerBottom, nextInnerBottom,
      outerTop, nextOuterTop, nextInnerTop,
      outerTop, nextInnerTop, innerTop,
      outerBottom, innerBottom, nextInnerBottom,
      outerBottom, nextInnerBottom, nextOuterBottom,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.garmentRepresentation = {
    kind: 'closed-fitted-diagonal-waist-shell',
    segments,
    frontSideRearContinuous: true,
    thickness: outerX - innerX,
    diagonalRise: 0.24,
  };
  return geometry;
}

/**
 * Closed fitted shorts shell with a real front crotch transition.  The
 * polygon is a garment outline in the pelvis plane and ExtrudeGeometry closes
 * the front, rear, hem, waist, and inner-crotch surfaces; it is not a
 * camera-facing panel or a central cylindrical plug.
 */
function fittedShortsShellGeometry(depth = 0.50): THREE.BufferGeometry {
  const outline: Array<[number, number]> = [
    [-0.66, -0.08],
    [0.66, -0.08],
    [0.74, -0.22],
    [0.82, -1.16],
    [0.30, -1.16],
    [0.22, -1.02],
    [0.00, -1.12],
    [-0.22, -1.02],
    [-0.30, -1.16],
    [-0.82, -1.16],
    [-0.74, -0.22],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (const [x, y] of outline.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.garmentRepresentation = {
    kind: 'closed-fitted-shorts-shell',
    frontBackClosed: true,
    waistClosed: true,
    crotch: 'explicit-upward-v-transition-between-two-leg-openings',
    centralHangingPlug: false,
    depth,
  };
  return geometry;
}

/** A tapered inner-garment gusset closes the inter-thigh volume without a
 * hanging belt flap or a camera-facing patch. */
function fittedCrotchGussetGeometry(): THREE.BufferGeometry {
  const sections = [
    // The gusset is the short inner-crotch bridge only.  It must terminate at
    // the shorts hem; extending it into the thigh tubes creates a visible
    // hanging dark plug that the reference does not contain.
    { y: -0.08, halfWidth: 0.22, depth: 0.18 },
    { y: -0.24, halfWidth: 0.20, depth: 0.18 },
    { y: -0.42, halfWidth: 0.12, depth: 0.17 },
    { y: -0.48, halfWidth: 0.055, depth: 0.16 },
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const section of sections) {
    const { y, halfWidth, depth } = section;
    positions.push(
      -halfWidth, y, -depth,
      halfWidth, y, -depth,
      halfWidth, y, depth,
      -halfWidth, y, depth,
    );
  }
  for (let ring = 0; ring < sections.length - 1; ring += 1) {
    const a = ring * 4;
    const b = (ring + 1) * 4;
    for (let edge = 0; edge < 4; edge += 1) {
      const next = (edge + 1) % 4;
      indices.push(a + edge, b + edge, a + next, a + next, b + edge, b + next);
    }
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const last = (sections.length - 1) * 4;
  indices.push(last, last + 2, last + 1, last, last + 3, last + 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.garmentRepresentation = {
    kind: 'tapered-inner-crotch-gusset',
    closed: true,
    attachedTo: 'closed-fitted-shorts-shell',
    replacesBackgroundCavity: true,
    genericCylinder: false,
  };
  return geometry;
}

function hairTube(points: Vec3[], radius: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const geometry = new THREE.TubeGeometry(curve, 14, radius, 6, false);
  geometry.computeVertexNormals();
  return geometry;
}

type HairSurface = 'front' | 'side' | 'rear';
type HairBinding = {
  u: number;
  v: number;
  surface: HairSurface;
  standProud: number;
  anchor?: string;
  root?: Vec3;
};

/**
 * Resolve a hair root in head-local scalp coordinates.  `u` is the lateral
 * coordinate (-1..1), `v` runs from the blindfold/hairline toward the crown,
 * and `surface` selects the visible front, lateral, or rear half of the skull.
 * Keeping the binding data separate from the generated points lets the hair
 * remain rigid-parented to `hair-root` without hiding a world-space placement
 * mistake inside a mesh transform.
 */
function scalpSurfacePoint(
  u: number,
  v: number,
  surface: HairSurface,
  standProud = 0.028,
): Vec3 {
  const lateral = THREE.MathUtils.clamp(u, -1, 1);
  const vertical = THREE.MathUtils.clamp(v, 0, 1);
  const y = 0.50 + vertical * 0.58;
  // Match the scalp coordinate field to the widened anatomical skull.  Hair
  // roots must resolve on the real temple/crown envelope instead of collapsing
  // toward the old narrow head axis.
  const rx = THREE.MathUtils.lerp(0.331, 0.176, vertical);
  const rz = THREE.MathUtils.lerp(0.200, 0.120, vertical);
  if (surface === 'rear') {
    return [lateral * rx * 0.86, y, -rz - standProud];
  }
  if (surface === 'side') {
    return [Math.sign(lateral || 1) * rx * 0.98, y, rz * 0.12 + standProud * 0.35];
  }
  const frontDepth = Math.sqrt(Math.max(0.12, 1 - lateral * lateral));
  return [lateral * rx, y, frontDepth * rz + standProud];
}

/**
 * Closed, variable-width low-poly loft for silhouette-defining hair locks.
 * The section is elliptical rather than a constant circular tube, and the
 * final ring tapers into a point so a lock cannot terminate in a floating
 * blunt cap.  All points are local to `hair-root` and share one stable frame.
 */
function taperedHairLoftGeometry(
  points: Vec3[],
  widths: number[],
  depths: number[],
  segs = 6,
): THREE.BufferGeometry {
  if (points.length < 2 || points.length !== widths.length || points.length !== depths.length) {
    throw new Error('taperedHairLoftGeometry requires matching point and profile arrays');
  }
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < points.length; ring += 1) {
    const point = new THREE.Vector3(...points[ring]);
    const previous = new THREE.Vector3(...points[Math.max(0, ring - 1)]);
    const next = new THREE.Vector3(...points[Math.min(points.length - 1, ring + 1)]);
    const tangent = next.sub(previous);
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 1, 0);
    tangent.normalize();
    const planar = new THREE.Vector3(tangent.x, tangent.y, 0);
    if (planar.lengthSq() < 1e-8) planar.set(0, 1, 0);
    planar.normalize();
    const normal = new THREE.Vector3(-planar.y, planar.x, 0);
    const depthAxis = new THREE.Vector3(0, 0, 1);
    const width = widths[ring];
    const depth = depths[ring];
    for (let i = 0; i < segs; i += 1) {
      const angle = (i / segs) * Math.PI * 2 + Math.PI / segs;
      const vertex = point.clone()
        .addScaledVector(normal, Math.cos(angle) * width)
        .addScaledVector(depthAxis, Math.sin(angle) * depth);
      vertices.push(vertex.x, vertex.y, vertex.z);
    }
  }
  for (let ring = 0; ring < points.length - 1; ring += 1) {
    const current = ring * segs;
    const next = (ring + 1) * segs;
    for (let i = 0; i < segs; i += 1) {
      const a = current + i;
      const b = current + ((i + 1) % segs);
      const c = next + i;
      const d = next + ((i + 1) % segs);
      if ((ring + i) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }
  const rootCenter = vertices.length / 3;
  vertices.push(...points[0]);
  const tipCenter = vertices.length / 3;
  vertices.push(...points[points.length - 1]);
  const lastRing = (points.length - 1) * segs;
  for (let i = 0; i < segs; i += 1) {
    const next = (i + 1) % segs;
    indices.push(rootCenter, next, i);
    indices.push(tipCenter, lastRing + i, lastRing + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.proceduralHair = {
    representation: 'tapered-elliptical-volumetric-loft',
    closedRoot: true,
    closedTip: true,
    rebuiltPerFrame: false,
  };
  return geometry;
}

/** Opaque base mass that follows the skull instead of leaving bald gaps. */
function scalpCapGeometry(segs = 10): THREE.BufferGeometry {
  const geometry = asymmetricSectionGeometry([
    { y: 0.48, rx: 0.340, frontDepth: 0.170, backDepth: 0.195, centerZ: -0.010 },
    { y: 0.60, rx: 0.380, frontDepth: 0.205, backDepth: 0.225, centerZ: -0.015 },
    { y: 0.78, rx: 0.370, frontDepth: 0.225, backDepth: 0.240, centerZ: -0.030 },
    { y: 0.94, rx: 0.310, frontDepth: 0.195, backDepth: 0.215, centerZ: -0.045 },
    { y: 1.07, rx: 0.230, frontDepth: 0.150, backDepth: 0.170, centerZ: -0.060 },
    { y: 1.13, rx: 0.108, frontDepth: 0.080, backDepth: 0.090, centerZ: -0.070 },
  ], Math.max(10, segs));
  // The skull envelope is deeper at the forehead than the original cap
  // stations.  A small rigid stand-proud offset keeps the opaque scalp mass
  // visible and attached at the hairline instead of letting skin occlude it.
  geometry.translate(0, 0, 0.085);
  geometry.userData.proceduralHair = {
    representation: 'opaque-continuous-scalp-cap',
    alphaCard: false,
    scalpExposureGate: 'required',
  };
  return geometry;
}

function annotateHairBinding(
  part: THREE.Group,
  binding: HairBinding,
  tier: 'hero' | 'mid' | 'preview',
): void {
  part.userData.hairBinding = {
    coordinateSpace: 'head-local-scalp-uv',
    u: binding.u,
    v: binding.v,
    surface: binding.surface,
    standProud: binding.standProud,
    rigidParent: 'hair-root',
    attachmentAnchor: binding.anchor ?? 'scalp-surface',
    resolvedRoot: binding.root ?? scalpSurfacePoint(binding.u, binding.v, binding.surface, binding.standProud),
  };
  part.userData.hairLodTier = tier;
}

function triangleCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    count += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(count);
}

function makePart(
  root: THREE.Group,
  nodes: Record<string, THREE.Object3D>,
  meshes: Record<string, THREE.Mesh>,
  id: string,
  geometry: THREE.BufferGeometry | THREE.Mesh,
  material: THREE.Material,
  options: {
    parent?: THREE.Object3D;
    role?: string;
    level?: 'macro' | 'meso' | 'micro';
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    castShadow?: boolean;
    receiveShadow?: boolean;
  } = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  if (options.position) group.position.set(...options.position);
  if (options.rotation) group.rotation.set(...options.rotation);
  if (options.scale) group.scale.set(...options.scale);
  group.userData.sculptComponent = {
    id,
    name: id,
    level: options.level ?? 'macro',
    role: options.role ?? 'lee-sin-part',
    importance: options.level === 'micro' ? 0.55 : options.level === 'meso' ? 0.8 : 0.95,
    confidence: 0.9,
    parent: options.parent?.name ?? 'root',
    attachment: {
      socket: `${id}-socket`,
      embedDepth: 0.02,
      gapTolerance: 0.01,
      attachedToParent: Boolean(options.parent),
    },
    actionProfile: {
      animationRole: id.includes('joint') || id.includes('pivot') ? 'joint' : 'static',
      pivot: { mode: 'component-center', localPosition: [0, 0, 0], axis: [0, 1, 0] },
      transformChannels: { translate: true, rotate: true, scale: true, visibility: true },
      sockets: [`${id}-socket`],
      collider: { type: 'box', isTrigger: false },
      destruction: { breakable: false, fractureGroup: options.parent?.name ?? id, seamRefs: [] },
    },
    semanticMaterial: material.name,
  };

  const sourceMesh = geometry instanceof THREE.Mesh ? geometry : undefined;
  const sourceGeometry: THREE.BufferGeometry = sourceMesh ? sourceMesh.geometry : geometry as THREE.BufferGeometry;
  const mesh = new THREE.Mesh(sourceGeometry, material);
  if (sourceMesh) {
    mesh.position.copy(sourceMesh.position);
    mesh.quaternion.copy(sourceMesh.quaternion);
    mesh.scale.copy(sourceMesh.scale);
  }
  mesh.name = '';
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  group.add(mesh);
  (options.parent ?? root).add(group);
  nodes[id] = group;
  meshes[id] = mesh;
  return group;
}

function makeSkinnedPart(
  nodes: Record<string, THREE.Object3D>,
  meshes: Record<string, THREE.Mesh>,
  id: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  bones: THREE.Bone[],
  parent: THREE.Object3D,
  role: string,
): { group: THREE.Group; mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton } {
  const group = new THREE.Group();
  group.name = id;
  group.userData.sculptComponent = {
    id,
    name: id,
    level: 'macro',
    role,
    importance: 1,
    confidence: 0.9,
    parent: parent.name,
    attachment: {
      socket: `${id}-socket`,
      embedDepth: 0,
      gapTolerance: 0,
      attachedToParent: true,
    },
    actionProfile: {
      animationRole: 'skinned-anatomy',
      pivot: { mode: 'skeleton', localPosition: [0, 0, 0], axis: [0, 1, 0] },
      transformChannels: { translate: true, rotate: true, scale: true, visibility: true },
      sockets: [`${id}-socket`],
      collider: { type: 'box', isTrigger: false },
      destruction: { breakable: false, fractureGroup: 'torso', seamRefs: [] },
    },
    semanticMaterial: material.name,
  };
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = '';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  parent.add(group);
  parent.updateWorldMatrix(true, true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.normalizeSkinWeights();
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  nodes[id] = group;
  meshes[id] = mesh;
  return { group, mesh, skeleton };
}

/**
 * Semantic boundary retained for the runtime/destruction contract without
 * introducing another visible skin block. Organic anatomy is represented by
 * the owning continuous surface; these groups only preserve named inventory.
 */
function makeSemanticGroup(
  nodes: Record<string, THREE.Object3D>,
  id: string,
  parent: THREE.Object3D,
  role: string,
): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.userData.sculptComponent = {
    id,
    name: id,
    level: 'macro',
    role,
    importance: 0.95,
    confidence: 0.9,
    parent: parent.name,
    attachment: {
      socket: `${id}-socket`,
      embedDepth: 0.02,
      gapTolerance: 0.01,
      attachedToParent: true,
    },
  };
  parent.add(group);
  nodes[id] = group;
  return group;
}

function addDetail(
  owner: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
  scale?: Vec3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = '';
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  if (scale) mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.explodeWithParent = true;
  owner.add(mesh);
  return mesh;
}

/** Soft studio lights; geometry remains responsible for silhouette and form. */
export function createLeeSinLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'lee-sin-lookdev-lights';
  lights.add(new THREE.HemisphereLight(0xf0f2f5, 0x6b422f, 0.18));
  const key = new THREE.DirectionalLight(0xfff4e8, 1.05);
  key.position.set(3.6, 6.5, 4.3);
  key.intensity = 2.45;
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 24;
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -1;
  // The continuous low-poly envelope is both caster and receiver. A small
  // normal bias removes shadow-map acne that otherwise paints diagonal
  // self-shadow streaks across the connected skin and garment surfaces.
  key.shadow.normalBias = 0.018;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xffbd91, 0.28);
  fill.position.set(-3.5, 3.2, 2.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffc56b, 0.12);
  rim.position.set(-1.2, 4.0, -4.0);
  lights.add(rim);
  return lights;
}

export function createLeeSinModel(options: LeeSinOptions = {}): THREE.Group {
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;
  const animate = options.animate ?? true;

  const root = new THREE.Group();
  root.name = 'lee-sin-root';
  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};

  // SKIN — clearcoat is the carrier, and every base roughness below is UNCHANGED on purpose. Those
  // numbers were tuned against this reference under this lighting, and the standing rule is that
  // roughness is never re-gated from a reference whose lighting is unknown. Clearcoat ADDS the broad
  // soft dielectric highlight that separates skin from matte cloth; it does not license retuning.
  //
  // No `transmission` anywhere: it is a screen-space refraction (glass) model, not subsurface
  // scattering, and on a closed body mesh it renders a glassy figure for the price of an extra
  // render target. Forbidden for the skin family in the material registry for that reason.
  //
  // One engine coupling to know: `clearcoatRoughness += geometryRoughness`
  // (lights_physical_fragment.glsl.js:73), derived from screen-space normal derivatives. So the
  // flat-shaded skin materials below read blurrier than the smooth-shaded ones from the SAME 0.38.
  // That is three.js, not a mismatch — and it is why the faceted face pieces are given a slightly
  // tighter coat than the smooth body.
  const skin = mat('skin', PALETTE.skin, 0.72, {
    flatShading: false,
    clearcoat: 0.18,
    clearcoatRoughness: 0.38,
    ior: 1.4,
  });
  // The face carries larger intentional cheek/jaw planes than the torso;
  // keep its faceting independent so the body can retain continuous soft
  // normals without turning the skull into a featureless smooth capsule.
  const skinFace = mat('skin-face', PALETTE.skin, 0.74, {
    flatShading: true,
    clearcoat: 0.16,
    clearcoatRoughness: 0.32,
    ior: 1.4,
  });
  const skinMid = mat('skin-mid', 0xc27b45, 0.78, {
    flatShading: true,
    clearcoat: 0.16,
    clearcoatRoughness: 0.32,
    ior: 1.4,
  });
  const faceLine = mat('face-line', 0x6e3d2b, 0.86, {
    flatShading: true,
    clearcoat: 0.16,
    clearcoatRoughness: 0.32,
    ior: 1.4,
  });
  const skinDeep = mat('skin-deep', PALETTE.skinDeep, 0.78, {
    flatShading: false,
    clearcoat: 0.18,
    clearcoatRoughness: 0.38,
    ior: 1.4,
  });
  const hair = mat('hair', PALETTE.hair, 0.88, {
    side: THREE.FrontSide,
    sheen: 0.6,
    sheenColor: 0xfff6e8,
    sheenRoughness: 0.3,
    ior: 1.55,
  });
  const blindfold = mat('blindfold', PALETTE.blindfold, 0.70, {
    sheen: 0.62,
    sheenColor: 0xf6ede0,
    sheenRoughness: 0.75,
  });
  const tattoo = mat('tattoo', PALETTE.tattoo, 0.55, {
    clearcoat: 0.16,
    clearcoatRoughness: 0.32,
    ior: 1.4,
  });
  const pants = mat('pants', PALETTE.pants, 0.82, {
    sheen: 0.6,
    sheenColor: 0xe9e6df,
    sheenRoughness: 0.85,
  });
  const pantsDark = mat('pants-dark', PALETTE.pantsDark, 0.86, {
    sheen: 0.6,
    sheenColor: 0xe9e6df,
    sheenRoughness: 0.88,
  });
  const sash = mat('sash', PALETTE.sash, 0.68, {
    sheen: 0.65,
    sheenColor: 0xf6ede0,
    sheenRoughness: 0.72,
  });
  const wrap = mat('wrap', PALETTE.wrap, 0.80, {
    sheen: 0.7,
    sheenColor: 0xefe6d8,
    sheenRoughness: 0.92,
  }); // coarse bandage linen: the broadest rim on the figure
  const gold = mat('gold', PALETTE.gold, 0.28, {
    metalness: 0.85,
    emissive: PALETTE.gold,
    emissiveIntensity: 0.15,
  });
  const goldBright = mat('gold-bright', PALETTE.goldBright, 0.22, {
    metalness: 0.90,
    emissive: PALETTE.goldBright,
    emissiveIntensity: 0.26,
  });
  const sole = mat('sole', PALETTE.sole, 0.90);

  // ── Named animation pivots ────────────────────────────────────────────────
  const pelvis = new THREE.Group();
  pelvis.name = 'pivot-pelvis';
  // The current waist/belt landmark sits high against the admitted plate. Move
  // only the pelvis/garment chain down; the spine offset below cancels that
  // translation at the shoulder so upper-body landmarks remain fixed.
  pelvis.position.set(0, 4.05, 0);
  root.add(pelvis);
  nodes[pelvis.name] = pelvis;

  const spine = new THREE.Group();
  spine.name = 'pivot-spine';
  spine.position.set(0, 0.20, 0);
  pelvis.add(spine);
  nodes[spine.name] = spine;

  const chest = new THREE.Group();
  chest.name = 'pivot-chest';
  chest.position.set(0, 0.40, 0);
  spine.add(chest);
  nodes[chest.name] = chest;

  const chestSkinBone = new THREE.Bone();
  chestSkinBone.name = 'skin-bone-chest';
  chest.add(chestSkinBone);
  nodes[chestSkinBone.name] = chestSkinBone;

  const neck = new THREE.Group();
  neck.name = 'pivot-neck';
  neck.position.set(0, 0.86, 0);
  chest.add(neck);
  nodes[neck.name] = neck;

  const headPivot = new THREE.Group();
  headPivot.name = 'pivot-head';
  // Lower the complete head frame to the measured crown line.  Keeping this
  // as one parent transform moves skull, blindfold, scalp, bun, and locks
  // together without introducing a floating facial or hair attachment.
  headPivot.position.set(0, 0.58, 0);
  headPivot.scale.set(...HEAD_FRAME_SCALE);
  neck.add(headPivot);
  nodes[headPivot.name] = headPivot;

  // The neck remains a named pivot/group for the public runtime contract, but
  // its visible skin is now part of the same closed envelope as the torso.
  // The bone is located at the neck pivot so head/neck motion can still be
  // introduced without reintroducing a capped volume intersection.
  const neckSkinBone = new THREE.Bone();
  neckSkinBone.name = 'skin-bone-neck';
  neck.add(neckSkinBone);
  nodes[neckSkinBone.name] = neckSkinBone;

  const mkArm = (side: 1 | -1, label: 'l' | 'r') => {
    const shoulder = new THREE.Bone();
    shoulder.name = `pivot-${label}-shoulder`;
    // The source plate has a broad athletic clavicle span; keep the waist
    // narrow while giving the shoulder line enough lateral reach to avoid a
    // compressed stocky read.
    shoulder.position.set(side * PASS1_PROPORTIONS.shoulderX, PASS1_PROPORTIONS.shoulderY, 0.02);
    shoulder.rotation.z = side * PASS1_PROPORTIONS.shoulderRotationZ;
    chestSkinBone.add(shoulder);
    nodes[shoulder.name] = shoulder;

    const elbow = new THREE.Bone();
    elbow.name = `pivot-${label}-elbow`;
    elbow.position.set(side * PASS1_PROPORTIONS.elbowX, PASS1_PROPORTIONS.elbowY, 0.01);
    shoulder.add(elbow);
    nodes[elbow.name] = elbow;

    const wrist = new THREE.Bone();
    wrist.name = `pivot-${label}-wrist`;
    wrist.position.set(side * PASS1_PROPORTIONS.wristX, PASS1_PROPORTIONS.wristY, 0);
    elbow.add(wrist);
    nodes[wrist.name] = wrist;
    return { shoulder, elbow, wrist };
  };
  const leftArm = mkArm(1, 'l');
  const rightArm = mkArm(-1, 'r');

  const mkLeg = (side: 1 | -1, label: 'l' | 'r') => {
    const hip = new THREE.Group();
    hip.name = `pivot-${label}-hip`;
    // Wider inter-leg spacing keeps the lower pants split readable while the
    // garment profile supplies the moderate thigh volume.
    hip.position.set(side * PASS1_PROPORTIONS.hipX, -0.15, 0);
    pelvis.add(hip);
    nodes[hip.name] = hip;

    const knee = new THREE.Group();
    knee.name = `pivot-${label}-knee`;
    knee.position.set(side * 0.05, PASS1_PROPORTIONS.kneeY, 0.01);
    hip.add(knee);
    nodes[knee.name] = knee;

    const ankle = new THREE.Group();
    ankle.name = `pivot-${label}-ankle`;
    ankle.position.set(0, PASS1_PROPORTIONS.ankleY, 0);
    knee.add(ankle);
    nodes[ankle.name] = ankle;
    return { hip, knee, ankle };
  };
  const leftLeg = mkLeg(1, 'l');
  const rightLeg = mkLeg(-1, 'r');

  // ── Pass 1: one watertight skinned body envelope ─────────────────────────
  // Bone ordering is explicit because every vertex stores stable indices.
  const anatomyBones = [
    chestSkinBone,
    neckSkinBone,
    leftArm.shoulder,
    leftArm.elbow,
    leftArm.wrist,
    rightArm.shoulder,
    rightArm.elbow,
    rightArm.wrist,
  ];
  const connectedAnatomy = makeSkinnedPart(
    nodes,
    meshes,
    'torso',
    connectedUpperBodyGeometry({
      chest: 0,
      neck: 1,
      shoulderL: 2,
      elbowL: 3,
      wristL: 4,
      shoulderR: 5,
      elbowR: 6,
      wristR: 7,
    }),
    skin,
    anatomyBones,
    chest,
    'watertight-connected-upper-body-blockout',
  );
  const torso = connectedAnatomy.group;
  for (const label of ['l', 'r'] as const) {
    makeSemanticGroup(nodes, `integrated-pectoral-${label}`, torso, 'integrated-into-continuous-torso-surface');
  }
  // Pigment is authored as angular vector paths but evaluated against the
  // torso/arm section surface.  The paths are skin-weighted with the same
  // bone indices as the continuous anatomy; there is no camera-facing panel.
  const surfaceMarkPaths: SurfaceMarkPath[] = [];
  for (const side of [1, -1] as const) {
    // Two stacked upper-pectoral chevrons, kept small and high under the
    // clavicle as in the admitted turnaround design.
    surfaceMarkPaths.push(
      [{ x: side * 0.10, y: 0.69 }, { x: side * 0.23, y: 0.57 }],
      [{ x: side * 0.23, y: 0.57 }, { x: side * 0.36, y: 0.69 }],
      [{ x: side * 0.13, y: 0.53 }, { x: side * 0.23, y: 0.43 }],
      [{ x: side * 0.23, y: 0.43 }, { x: side * 0.33, y: 0.53 }],
    );
    // Angular upper-arm mark follows the arm centreline rather than being
    // mirrored as a horizontal stripe.
    surfaceMarkPaths.push([
      { x: side * 1.13, y: 0.35 },
      { x: side * 1.28, y: 0.24 },
      { x: side * 1.18, y: 0.13 },
    ]);
    // The forearm mark is intentionally a separate zig-zag section so its
    // attachment remains legible when the elbow/wrist pivots move.
    surfaceMarkPaths.push([
      { x: side * 1.77, y: -0.51 },
      { x: side * 1.94, y: -0.63 },
      { x: side * 1.84, y: -0.78 },
    ]);
  }
  const chestTattoo = makeSkinnedPart(
    nodes,
    meshes,
    'chest-tattoo',
    attachedSurfaceMarkGeometry(surfaceMarkPaths, 0.045, {
      chest: 0,
      neck: 1,
      shoulderL: 2,
      elbowL: 3,
      wristL: 4,
      shoulderR: 5,
      elbowR: 6,
      wristR: 7,
    }),
    tattoo,
    anatomyBones,
    torso,
    'skin-bound-vector-body-markings',
  ).group;
  chestTattoo.userData.surfaceMarks = {
    status: 'implemented',
    classification: 'P',
    representation: 'closed-skin-bound-vector-mark-volume',
    pathCount: surfaceMarkPaths.length,
    skinWeighted: true,
    surfaceAnchor: 'torso section-depth uv + barycentric-ready source coordinates',
    tangentFrame: 'finite-difference front-surface normal in shared bind space',
    jointBinding: 'same skinIndex/skinWeight attributes as the continuous torso-arm envelope',
    surfaceZones: { torso: 0, upperArm: 1, forearm: 2 },
    normalOffsetSpace: 'surface-normal',
    closed: true,
    rigidParent: 'torso',
    floatingPanelForbidden: true,
  };

  // The upper pectoral, trapezius, deltoid and exposed arm are regions of the
  // same indexed mesh. No shoulder sphere, arm cap or hidden bridge exists.
  torso.userData.anatomy = {
    upperPectoralVolume: 'connected-faceted-envelope',
    sternumGroove: 'deferred-to-face-and-marking-detail-pass',
    shoulderTransition: 'shared-watertight-surface',
    neckTransition: 'integrated-cervical-section-to-head-attachment-cap',
    skeleton: connectedAnatomy.skeleton,
  };
  meshes.neck = connectedAnatomy.mesh;

  const sashPart = makePart(
    root,
    nodes,
    meshes,
    'sash',
    profileGeometry([
      [-0.18, 0.56, 0.34],
      [0.16, 0.56, 0.34],
    ], 10),
    sash,
    { parent: pelvis, role: 'horizontal-waistband-only', level: 'meso', position: [0, -0.08, 0], castShadow, receiveShadow },
  );
  sashPart.userData.rebuildNote = 'horizontal baseline waistband; diagonal wrap is a sibling attachment';
  // Baseline belt: a horizontal waistband plus a diagonal sash that continues
  // around the right hip. There is no central hanging flap or diamond knot.
  const diagonalSashFront = makePart(
    root,
    nodes,
    meshes,
    'sash-diagonal-front',
    diagonalSashShellGeometry(),
    sash,
    { parent: pelvis, role: 'closed-fitted-diagonal-sash-wrap', level: 'meso', position: [0, 0, 0], castShadow, receiveShadow },
  );
  diagonalSashFront.userData.rebuildNote = 'closed ellipse-following strip continues through front, side, and rear hip';
  makeSemanticGroup(nodes, 'sash-diagonal-hip', pelvis, 'continuous-diagonal-sash-hip-region');

  const pantsHips = makePart(
    root,
    nodes,
    meshes,
    'pants-hips',
    fittedShortsShellGeometry(0.50),
    pants,
    { parent: pelvis, role: 'closed-fitted-shorts-shell', position: [0, -0.06, 0], castShadow, receiveShadow },
  );
  pantsHips.userData.rebuildNote = 'closed front/back garment with explicit crotch V; no central hanging plug or geometry above waistband';
  const pantsCrotchGusset = makePart(
    root,
    nodes,
    meshes,
    'pants-crotch-gusset',
    fittedCrotchGussetGeometry(),
    pants,
    { parent: pelvis, role: 'tapered-closed-inner-crotch-gusset', level: 'meso', position: [0, -0.06, 0.025], castShadow, receiveShadow },
  );
  pantsCrotchGusset.userData.rebuildNote = 'closed tapered inner volume; fills inter-thigh background without a belt flap';

  // Semantic regions retain the inspectable runtime vocabulary while all of
  // their visible skin vertices live in `torso`'s single connected manifold.
  for (const [pivots, label] of [[leftArm, 'l'], [rightArm, 'r']] as const) {
    const upperArm = makeSemanticGroup(nodes, `upper-arm-${label}`, pivots.shoulder, 'skinned-region-upper-arm');
    makeSemanticGroup(nodes, `shoulder-cap-${label}`, upperArm, 'skinned-region-deltoid');
    makeSemanticGroup(nodes, `clavicle-${label}`, upperArm, 'skinned-region-clavicle');
    meshes[`upper-arm-${label}`] = connectedAnatomy.mesh;
  }

  const buildArm = (
    label: 'l' | 'r',
    pivots: { shoulder: THREE.Bone; elbow: THREE.Bone; wrist: THREE.Bone },
  ) => {
    const upperArm = nodes[`upper-arm-${label}`] as THREE.Group;
    upperArm.userData.surfaceMarks = {
      status: 'implemented',
      classification: 'P',
      representation: 'shared-torso-surface-anchor-attached-angular-mark',
      sourceMesh: 'chest-tattoo',
      zones: { torso: 0, upperArm: 1, forearm: 2 },
      sharedSkinWeights: true,
      normalOffsetSpace: 'surface-normal',
      floatingPanelForbidden: true,
    };
    if (label === 'r') {
      makePart(
        root,
        nodes,
        meshes,
        'gold-armband-r',
        profileGeometry([[-0.78, 0.285, 0.275], [-0.58, 0.285, 0.275]], 8),
        gold,
        { parent: upperArm, role: 'gold-upper-arm-band', level: 'meso', castShadow, receiveShadow },
      );
    }
    makeSemanticGroup(nodes, `elbow-${label}`, pivots.elbow, 'skinned-region-elbow');
    makeSemanticGroup(nodes, `forearm-${label}`, pivots.elbow, 'skinned-region-proximal-forearm');
    meshes[`elbow-${label}`] = connectedAnatomy.mesh;
    meshes[`forearm-${label}`] = connectedAnatomy.mesh;
    const forearmWrap = makePart(
      root,
      nodes,
      meshes,
      `forearm-wrap-${label}`,
      profileGeometry([
        [-0.90, 0.15, 0.15],
        [-0.84, 0.17, 0.16],
        [-0.76, 0.175, 0.165],
        [-0.68, 0.17, 0.16],
        [-0.62, 0.15, 0.15],
      ], 7),
      wrap,
      { parent: pivots.elbow, role: 'short-angular-forearm-wrap', level: 'meso', castShadow, receiveShadow },
    );
    addDetail(forearmWrap, new THREE.TorusGeometry(0.15, 0.018, 4, 8), wrap, [0, -0.66, 0], [Math.PI / 2, 0, 0]);
    addDetail(forearmWrap, new THREE.TorusGeometry(0.16, 0.018, 4, 8), wrap, [0, -0.76, 0], [Math.PI / 2, 0, 0]);
    addDetail(forearmWrap, new THREE.TorusGeometry(0.15, 0.018, 4, 8), wrap, [0, -0.86, 0], [Math.PI / 2, 0, 0]);
    makePart(
      root,
      nodes,
      meshes,
      `wrist-wrap-${label}`,
      profileGeometry([[-0.13, 0.15, 0.15], [0.11, 0.16, 0.16]], 7),
      wrap,
      { parent: pivots.wrist, role: 'short-wrist-wrap', level: 'meso', position: [0, -0.02, 0], castShadow, receiveShadow },
    );
    const hand = makePart(
      root,
      nodes,
      meshes,
      `hand-${label}`,
      openHandGeometry(label === 'l' ? 1 : -1),
      skin,
      { parent: pivots.wrist, role: 'open-palm-thumb-finger-hand', level: 'meso', position: [0, -0.10, 0.04], scale: PASS1_HAND_SCALE, castShadow, receiveShadow },
    );
    hand.userData.anatomy = {
      classification: ['G', 'J', 'F'],
      representation: 'closed-open-hand-envelope',
      attachment: 'wrist-to-palm with lateral thumb wedge',
    };
  };
  buildArm('l', leftArm);
  buildArm('r', rightArm);

  // ── Pass 3: straight pants, exposed calves, short ankle boots ────────────
  const buildLeg = (
    label: 'l' | 'r',
    pivots: { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group },
  ) => {
    const side = label === 'l' ? 1 : -1;
    makePart(
      root,
      nodes,
      meshes,
      `thigh-${label}`,
      profileGeometry([
        [-2.64, 0.34 * straightPantsWidthScaleAt(-2.64), 0.27],
        [-2.50, 0.42 * straightPantsWidthScaleAt(-2.50), 0.31],
        [-2.18, 0.44 * straightPantsWidthScaleAt(-2.18), 0.31],
        [-1.66, 0.42 * straightPantsWidthScaleAt(-1.66), 0.30, -side * 0.07],
        [-1.22, 0.38 * straightPantsWidthScaleAt(-1.22), 0.29, -side * 0.12],
        [-0.78, 0.32 * straightPantsWidthScaleAt(-0.78), 0.28, -side * 0.18],
        [-0.42, 0.28 * straightPantsWidthScaleAt(-0.42), 0.27, -side * 0.18],
        [-0.18, 0.30 * straightPantsWidthScaleAt(-0.18), 0.24, -side * 0.12],
        [-0.08, 0.21, 0.19],
      ], 9),
      pants,
      { parent: pivots.hip, role: 'straight-knee-length-pants', castShadow, receiveShadow },
    );
    makePart(
      root,
      nodes,
      meshes,
      `pants-hem-${label}`,
      profileGeometry([
        [-2.72, 0.38, 0.29],
        [-2.58, 0.44, 0.32],
        [-2.40, 0.43, 0.31],
      ], 8),
      pantsDark,
      { parent: pivots.hip, role: 'angular-knee-level-pants-hem', level: 'meso', castShadow, receiveShadow },
    );
    const thighWrap = makePart(
      root,
      nodes,
      meshes,
      `thigh-wrap-${label}`,
      profileGeometry([
        [-1.50, 0.37, 0.33],
        [-1.20, 0.37, 0.33],
      ], 9),
      sash,
      { parent: pivots.hip, role: label === 'r' ? 'asymmetric-red-thigh-wrap-primary' : 'asymmetric-red-thigh-wrap-secondary', level: 'meso', position: [0, 0, 0], castShadow, receiveShadow },
    );
    if (label === 'r') {
      addDetail(thighWrap, profileGeometry([[-1.18, 0.37, 0.34], [-0.98, 0.37, 0.34]], 9), sash);
    } else {
      addDetail(thighWrap, profileGeometry([[-1.30, 0.34, 0.32], [-1.08, 0.34, 0.32]], 9), wrap);
    }
    const shin = makePart(
      root,
      nodes,
      meshes,
      `shin-${label}`,
      asymmetricSectionGeometry([
      { y: -0.92, rx: 0.19, frontDepth: 0.16, backDepth: 0.16 },
      { y: -0.72, rx: 0.23, frontDepth: 0.21, backDepth: 0.20 },
      { y: -0.52, rx: 0.27, frontDepth: 0.24, backDepth: 0.22 },
      { y: -0.40, rx: 0.34, frontDepth: 0.29, backDepth: 0.27 },
      { y: -0.08, rx: 0.33, frontDepth: 0.29, backDepth: 0.26 },
      { y: 0.24, rx: 0.29, frontDepth: 0.25, backDepth: 0.23 },
      ], 10),
      skin,
      { parent: pivots.knee, role: 'exposed-tan-calf', castShadow, receiveShadow },
    );
    shin.userData.anatomy = {
      classification: ['G', 'J', 'F'],
      representation: 'closed-asymmetric-section-loft',
      sections: 'calf-bulge -> shin-plane -> ankle-taper',
    };
    makePart(
      root,
      nodes,
      meshes,
      `knee-${label}`,
      profileGeometry([[-0.11, 0.19, 0.18], [0.10, 0.19, 0.18]], 8),
      skinDeep,
      { parent: pivots.knee, role: 'knee-connector', level: 'micro', castShadow, receiveShadow },
    );
    const ankleWrap = makePart(
      root,
      nodes,
      meshes,
      `ankle-wrap-${label}`,
      profileGeometry([
        [0.00, 0.145, 0.15],
        [0.08, 0.160, 0.16],
        [0.18, 0.165, 0.17],
        [0.28, 0.155, 0.16],
        [0.36, 0.140, 0.15],
      ], 8),
      wrap,
      { parent: pivots.ankle, role: 'short-ankle-boot', level: 'meso', position: [0, 0, 0.08], castShadow, receiveShadow },
    );
    addDetail(ankleWrap, new THREE.TorusGeometry(0.145, 0.015, 4, 8), wrap, [0, 0.05, 0], [Math.PI / 2, 0, 0]);
    addDetail(ankleWrap, new THREE.TorusGeometry(0.155, 0.015, 4, 8), wrap, [0, 0.17, 0], [Math.PI / 2, 0, 0]);
    addDetail(ankleWrap, new THREE.TorusGeometry(0.140, 0.015, 4, 8), wrap, [0, 0.29, 0], [Math.PI / 2, 0, 0]);
    const foot = makePart(
      root,
      nodes,
      meshes,
      `foot-${label}`,
      // The reference's simple martial-artist foot has a broad toe wedge;
      // widen the footprint without increasing the shaft or adding a sole
      // platform.
      angularFootGeometry(0.52, 0.20, -0.14, 0.34, 0.16),
      skin,
      { parent: pivots.ankle, role: 'compact-angular-foot', level: 'meso', position: [side * 0.05, -0.35 + PASS1_PROPORTIONS.footLift, 0.18], rotation: [0, side * 0.12, 0], castShadow, receiveShadow },
    );
    // Keep the ankle-facing foot volume broad, but taper the actual contact
    // patch.  The front reference resolves each bottom run at roughly four
    // pixels; matching the full 0.52-wide instep produced a platform sole.
    addDetail(foot, angularFootGeometry(0.30, 0.035, -0.15, 0.35), sole, [0, -0.11, 0.02]);
  };
  buildLeg('l', leftLeg);
  buildLeg('r', rightLeg);

  // ── Neck, head and frozen hair/blindfold structure ────────────────────────
  neck.userData.anatomy = {
    classification: ['G', 'J', 'F'],
    representation: 'integrated-continuous-envelope-neck-section',
    sections: NECK_ANATOMY_SECTIONS,
    transition: 'shared-torso-cervical-to-jaw-underhang',
    visibleMesh: 'torso',
  };
  const head = makePart(
    root,
    nodes,
    meshes,
    'head',
    asymmetricSectionGeometry(HEAD_ANATOMY_SECTIONS, 8),
    skinFace,
    // The admitted plate reads with a wider cheek/jaw frame than the previous
    // narrow tube.  Width is corrected on the closed skull volume itself;
    // hair and blindfold remain on their existing head-local attachment frame.
    // Keep the crown registered to the hair frame while extending the
    // jaw/chin downward; the previous short volume made the neck read too
    // long and attached the head directly to the shoulders.
    { parent: headPivot, role: 'closed-anatomical-skull-jaw-volume', position: [0, -0.20, 0.01], scale: [1.42, 1.05, 0.96], castShadow, receiveShadow },
  );
  head.userData.anatomy = {
    classification: ['G', 'J', 'F'],
    representation: 'closed-asymmetric-section-loft',
    sections: HEAD_ANATOMY_SECTIONS,
    landmarkContract: {
      hairline: 0.10,
      eyeLine: 0.46,
      noseBase: 0.68,
      mouthLine: 0.82,
      chin: 0.00,
    },
    attachment: 'head-local neck overlap only at the closed neck-to-jaw transition',
  };
  // Facial relief is a closed, parent-owned volume rather than a floating
  // panel. Head-local y runs from chin (0) upward; this bridge rises toward
  // the blindfold line and its wider lower station gives the reference nose
  // a readable planar tip.
  const nose = addDetail(head, asymmetricSectionGeometry([
    { y: 0.00, rx: 0.022, frontDepth: 0.020, backDepth: 0.016, centerZ: 0.248 },
    { y: 0.07, rx: 0.034, frontDepth: 0.029, backDepth: 0.019, centerZ: 0.251 },
    { y: 0.14, rx: 0.029, frontDepth: 0.026, backDepth: 0.018, centerZ: 0.246 },
    { y: 0.20, rx: 0.020, frontDepth: 0.019, backDepth: 0.016, centerZ: 0.238 },
  ], 6), skinMid, [0, 0.22, 0]);
  nose.name = 'face-nose-volume';
  nose.userData.anatomy = {
    classification: ['G', 'J', 'F'],
    representation: 'closed-low-poly-nasal-bridge-and-tip',
    attachedTo: 'closed-anatomical-skull-jaw-volume',
  };
  addDetail(head, profileGeometry([
    [0.12, 0.072, 0.018, 0, 0.232],
    [0.16, 0.060, 0.014, 0, 0.232],
  ], 6), faceLine);
  const lowerLip = addDetail(head, asymmetricSectionGeometry([
    { y: 0.07, rx: 0.050, frontDepth: 0.014, backDepth: 0.010, centerZ: 0.220 },
    { y: 0.10, rx: 0.078, frontDepth: 0.022, backDepth: 0.012, centerZ: 0.228 },
    { y: 0.13, rx: 0.066, frontDepth: 0.019, backDepth: 0.011, centerZ: 0.226 },
    { y: 0.16, rx: 0.040, frontDepth: 0.012, backDepth: 0.009, centerZ: 0.218 },
  ], 6), skinMid);
  lowerLip.name = 'face-lower-lip-volume';
  lowerLip.userData.anatomy = {
    classification: ['G', 'J', 'F'],
    representation: 'closed-attached-lower-lip-relief',
    attachedTo: 'closed-anatomical-skull-jaw-volume',
  };

  makePart(
    root,
    nodes,
    meshes,
    'blindfold',
    profileGeometry([
      [-0.10, 0.255, 0.16],
      [0.10, 0.255, 0.16],
    ], 8),
    blindfold,
    { parent: head, role: 'tight-horizontal-blindfold', level: 'meso', position: [0, 0.51, 0.13], rotation: [0.10, 0, 0], castShadow, receiveShadow },
  );
  // The front overlap is a fitted cloth section, not a rectangular face
  // panel: the lower edge is slightly narrower and the outer corners angle
  // with the wrap around the skull.
  addDetail(head, panel([[-0.30, 0.45], [0.30, 0.45], [0.275, 0.60], [-0.275, 0.60]], 0.040), blindfold, [0, 0, 0.285]);

  const hairRoot = new THREE.Group();
  hairRoot.name = 'hair-root';
  headPivot.add(hairRoot);
  nodes[hairRoot.name] = hairRoot;

  const hairLodParts: Array<{ part: THREE.Group; tier: 'hero' | 'mid' | 'preview' }> = [];
  const registerHair = (
    id: string,
    geometry: THREE.BufferGeometry,
    role: string,
    level: 'macro' | 'meso' | 'micro',
    binding: HairBinding,
    tier: 'hero' | 'mid' | 'preview' = 'hero',
    position?: Vec3,
    rotation?: Vec3,
  ): THREE.Group => {
    const part = makePart(root, nodes, meshes, id, geometry, hair, {
      parent: hairRoot,
      role,
      level,
      position,
      rotation,
      castShadow,
      receiveShadow,
    });
    annotateHairBinding(part, binding, tier);
    hairLodParts.push({ part, tier });
    return part;
  };

  makePart(root, nodes, meshes, 'blindfold-knot', ellipsoid(0.11, 0.08, 0.12, 0), blindfold, {
    parent: hairRoot,
    role: 'rear-blindfold-knot',
    level: 'micro',
    position: [0, 0.45, -0.32],
    castShadow,
    receiveShadow,
  });

  // Continuous opaque scalp mass.  Every silhouette lock overlaps this base
  // by design; no separate ellipsoid is allowed to stand in for attachment.
  registerHair(
    'hair-scalp-cap',
    scalpCapGeometry(24),
    'continuous-opaque-scalp-cap',
    'macro',
    { u: 0, v: 0.58, surface: 'front', standProud: 0.028 },
    'preview',
  );

  const topknot = registerHair(
    'hair-topknot',
    taperedHairLoftGeometry(
      [[0, -0.14, 0], [-0.015, -0.03, 0], [0.01, 0.10, -0.01], [0.025, 0.20, -0.025]],
      [0.16, 0.15, 0.21, 0.10],
      [0.13, 0.17, 0.17, 0.08],
      7,
    ),
    'tied-top-back-bun-volumetric',
    'meso',
    { u: 0, v: 0.98, surface: 'rear', standProud: 0.035 },
    'preview',
    [0.015, 1.18, -0.08],
  );
  const topknotTie = makePart(
    root,
    nodes,
    meshes,
    'hair-topknot-tie',
    profileGeometry([
      [-0.045, 0.125, 0.095],
      [0.035, 0.135, 0.098],
    ], 8),
    blindfold,
    {
      parent: hairRoot,
      role: 'red-topknot-tie',
      level: 'micro',
      position: [0.015, 1.18, -0.08],
      castShadow,
      receiveShadow,
    },
  );
  topknotTie.userData.hairAttachment = 'tied around the enlarged topknot base';

  const leftCrownRoot = scalpSurfacePoint(-0.58, 0.58, 'front', 0.035);
  registerHair(
    'hair-lock-l1',
    taperedHairLoftGeometry(
      [leftCrownRoot, [-0.26, 0.98, 0.14], [-0.14, 1.08, 0.07], [-0.06, 1.15, -0.02]],
      [0.10, 0.12, 0.08, 0.022],
      [0.08, 0.10, 0.065, 0.018],
    ),
    'scalp-bound-crown-sweep-left',
    'meso',
    { u: -0.58, v: 0.58, surface: 'front', standProud: 0.035 },
    'mid',
  );
  const rightCrownRoot = scalpSurfacePoint(0.58, 0.58, 'front', 0.035);
  registerHair(
    'hair-lock-r1',
    taperedHairLoftGeometry(
      [rightCrownRoot, [0.21, 0.97, 0.12], [0.12, 1.07, 0.06], [0.05, 1.14, -0.02]],
      [0.075, 0.090, 0.060, 0.016],
      [0.060, 0.074, 0.050, 0.013],
    ),
    'scalp-bound-crown-sweep-right',
    'meso',
    { u: 0.58, v: 0.58, surface: 'front', standProud: 0.035 },
    'mid',
  );

  const leftSideRoot = scalpSurfacePoint(-0.90, 0.45, 'side', 0.032);
  registerHair(
    'hair-lock-l2',
    taperedHairLoftGeometry(
      [leftSideRoot, [-0.28, 0.66, 0.10], [-0.29, 0.53, 0.07], [-0.27, 0.40, 0.035]],
      [0.080, 0.095, 0.065, 0.020],
      [0.065, 0.080, 0.052, 0.016],
    ),
    'scalp-bound-temple-lock-left',
    'meso',
    { u: -0.90, v: 0.45, surface: 'side', standProud: 0.032 },
    'mid',
  );
  const rightSideRoot = scalpSurfacePoint(0.90, 0.45, 'side', 0.032);
  registerHair(
    'hair-lock-r2',
    taperedHairLoftGeometry(
      [rightSideRoot, [0.28, 0.66, 0.10], [0.29, 0.53, 0.07], [0.27, 0.42, 0.035]],
      [0.075, 0.090, 0.062, 0.018],
      [0.060, 0.075, 0.050, 0.014],
    ),
    'scalp-bound-temple-lock-right',
    'meso',
    { u: 0.90, v: 0.45, surface: 'side', standProud: 0.032 },
    'mid',
  );

  const crownRoot = scalpSurfacePoint(0, 0.72, 'front', 0.035);
  registerHair(
    'hair-crown',
    taperedHairLoftGeometry(
      [crownRoot, [0, 0.98, 0.15], [0.02, 1.09, 0.07], [0, 1.15, -0.03]],
      [0.10, 0.13, 0.085, 0.021],
      [0.08, 0.105, 0.068, 0.017],
    ),
    'scalp-bound-crown-center',
    'meso',
    { u: 0, v: 0.72, surface: 'front', standProud: 0.035 },
    'mid',
  );
  registerHair(
    'hair-scalp-left',
    taperedHairLoftGeometry(
      [scalpSurfacePoint(-0.78, 0.68, 'side', 0.030), [-0.25, 0.82, 0.10], [-0.27, 0.65, 0.07], [-0.25, 0.52, 0.035]],
      [0.060, 0.075, 0.055, 0.018],
      [0.050, 0.062, 0.045, 0.014],
    ),
    'attached-scalp-lock-left',
    'meso',
    { u: -0.78, v: 0.68, surface: 'side', standProud: 0.030 },
    'hero',
  );
  registerHair(
    'hair-scalp-right',
    taperedHairLoftGeometry(
      [scalpSurfacePoint(0.78, 0.68, 'side', 0.030), [0.25, 0.82, 0.10], [0.27, 0.66, 0.07], [0.25, 0.53, 0.035]],
      [0.055, 0.070, 0.050, 0.016],
      [0.045, 0.058, 0.041, 0.013],
    ),
    'attached-scalp-lock-right',
    'meso',
    { u: 0.78, v: 0.68, surface: 'side', standProud: 0.030 },
    'hero',
  );
  registerHair(
    'hair-side-swept-left',
    taperedHairLoftGeometry(
      [scalpSurfacePoint(-0.68, 0.49, 'front', 0.040), [-0.32, 0.70, 0.26], [-0.38, 0.52, 0.24], [-0.41, 0.33, 0.20], [-0.44, 0.12, 0.14], [-0.45, -0.05, 0.08]],
      [0.080, 0.095, 0.080, 0.060, 0.038, 0.012],
      [0.064, 0.080, 0.066, 0.050, 0.032, 0.010],
    ),
    'attached-side-swept-scalp-lock',
    'meso',
    { u: -0.68, v: 0.49, surface: 'front', standProud: 0.040 },
    'hero',
  );


  const rearRoot = scalpSurfacePoint(0, 0.70, 'rear', 0.035);
  registerHair(
    'hair-lock-back',
    taperedHairLoftGeometry(
      [rearRoot, [0, 0.78, -0.29], [0.02, 0.59, -0.32], [0.03, 0.43, -0.27]],
      [0.13, 0.14, 0.095, 0.025],
      [0.10, 0.12, 0.085, 0.020],
    ),
    'scalp-bound-rear-lock-center',
    'meso',
    { u: 0, v: 0.70, surface: 'rear', standProud: 0.035 },
    'mid',
  );
  const trailingHairUpper = registerHair(
    'hair-trailing-lock-upper',
    taperedHairLoftGeometry(
      // Two controlled bends reproduce the broad upper ribbon: it lifts from
      // the rear knot, crests once, then drops toward the tip rather than
      // reading as a straight floating spike in the front view.
      [[0.20, 0.43, 0.10], [0.35, 0.38, 0.12], [0.55, 0.32, 0.12], [0.78, 0.28, 0.10], [0.95, 0.31, 0.08], [1.08, 0.24, 0.06], [1.25, 0.13, 0.035]],
      [0.050, 0.075, 0.095, 0.095, 0.082, 0.060, 0.024],
      [0.038, 0.052, 0.060, 0.052, 0.040, 0.025, 0.010],
    ),
    'attached-right-side-hair-trailing-lock-upper',
    'meso',
    { u: 0.90, v: 0.45, surface: 'side', standProud: 0.040 },
    'hero',
  );
  const trailingHairLower = registerHair(
    'hair-trailing-lock-lower',
    taperedHairLoftGeometry(
      // The lower lock is deliberately fuller and descends below the
      // blindfold line, matching the reference's second S-curve without
      // introducing a sideways red blindfold tail.
      [[0.18, 0.50, 0.08], [0.32, 0.42, 0.10], [0.48, 0.30, 0.10], [0.60, 0.22, 0.08], [0.68, 0.02, 0.06], [0.92, -0.08, 0.04], [1.30, -0.28, 0.02]],
      [0.060, 0.085, 0.105, 0.108, 0.095, 0.065, 0.025],
      [0.045, 0.060, 0.068, 0.060, 0.045, 0.027, 0.011],
    ),
    'attached-right-side-hair-trailing-lock-lower',
    'meso',
    { u: 0.82, v: 0.42, surface: 'side', standProud: 0.040 },
    'hero',
  );

  // TubeGeometry is reserved for small secondary locks whose rounded depth is
  // useful in profile/rear views. The primary identity silhouette remains
  // the custom tapered loft system above; these locks still start from a
  // scalp-resolved root and are rigid children of hairRoot.
  const secondaryRearLeft = hairTube([
    scalpSurfacePoint(-0.54, 0.86, 'rear', 0.030),
    [-0.24, 0.96, -0.31],
    [-0.28, 0.79, -0.36],
  ], 0.040);
  secondaryRearLeft.userData.proceduralHair = {
    representation: 'tube-geometry-secondary-rounded-lock',
    closedRoot: false,
    closedTip: true,
    rebuiltPerFrame: false,
  };
  registerHair(
    'hair-secondary-rear-left',
    secondaryRearLeft,
    'secondary-rounded-rear-lock-left',
    'micro',
    { u: -0.54, v: 0.86, surface: 'rear', standProud: 0.030 },
    'hero',
  );
  const secondaryRearRight = hairTube([
    scalpSurfacePoint(0.54, 0.86, 'rear', 0.030),
    [0.24, 0.96, -0.31],
    [0.28, 0.79, -0.36],
  ], 0.040);
  secondaryRearRight.userData.proceduralHair = {
    representation: 'tube-geometry-secondary-rounded-lock',
    closedRoot: false,
    closedTip: true,
    rebuiltPerFrame: false,
  };
  registerHair(
    'hair-secondary-rear-right',
    secondaryRearRight,
    'secondary-rounded-rear-lock-right',
    'micro',
    { u: 0.54, v: 0.86, surface: 'rear', standProud: 0.030 },
    'hero',
  );

  const hairLodRanks = { preview: 0, mid: 1, hero: 2 } as const;
  const setHairLodTier = (tier: 'hero' | 'mid' | 'preview'): void => {
    for (const { part, tier: partTier } of hairLodParts) {
      part.visible = hairLodRanks[partTier] <= hairLodRanks[tier];
    }
  };
  const hairLod = {
    tier: 'hero' as 'hero' | 'mid' | 'preview',
    distances: { hero: 0, mid: 7, preview: 13 },
    rebuiltPerFrame: false,
    setTier(tier: 'hero' | 'mid' | 'preview') {
      this.tier = tier;
      setHairLodTier(tier);
    },
    setDistance(distance: number) {
      this.setTier(distance >= this.distances.preview ? 'preview'
        : distance >= this.distances.mid ? 'mid' : 'hero');
    },
  };
  setHairLodTier('hero');
  const trailingHairUpperBaseZ = trailingHairUpper.rotation.z;
  const trailingHairLowerBaseZ = trailingHairLower.rotation.z;
  hairRoot.userData.hairTechnique = {
    representation: 'opaque-scalp-cap-plus-tapered-volumetric-locks-with-tube-secondary-locks',
    primaryLocks: 'custom-tapered-elliptical-lofts',
    secondaryLocks: 'TubeGeometry-rounded-rear-depth-locks',
    alphaCards: false,
    rendererDefault: 'WebGLRenderer',
    rootBinding: 'head-local-(u,v)-surface-resolve',
    standProud: 0.028,
    rigidParent: 'hair-root',
    scalpExposureGate: 'work/lee-sin/scalp-exposure-tube-secondary-v2.json',
    lod: 'distance-tiered-visibility-no-rebuild',
  };
  // The knot and both tails live behind the skull.  Keeping their z depth
  // negative prevents a front camera from reading a sideways red horn while
  // retaining real downward tails in profile/rear views.
  makePart(root, nodes, meshes, 'blindfold-ribbon-a', hairTube([[0.10, 0.72, -0.28], [0.09, 0.55, -0.36], [0.08, 0.32, -0.39], [0.07, 0.05, -0.35]], 0.055), blindfold, {
    parent: hairRoot,
    role: 'downward-rear-blindfold-tail',
    level: 'meso',
    castShadow,
    receiveShadow,
  });
  makePart(root, nodes, meshes, 'blindfold-ribbon-b', hairTube([[-0.08, 0.68, -0.30], [-0.07, 0.48, -0.38], [-0.06, 0.20, -0.40], [-0.05, -0.12, -0.35]], 0.050), blindfold, {
    parent: hairRoot,
    role: 'downward-rear-blindfold-tail',
    level: 'meso',
    castShadow,
    receiveShadow,
  });

  // ── Rings remain attached but do not participate in camera framing ────────
  const ringsRoot = new THREE.Group();
  ringsRoot.name = 'energy-rings';
  root.add(ringsRoot);
  nodes[ringsRoot.name] = ringsRoot;
  const makeRing = (id: 'ring-l' | 'ring-r', x: number) => {
    const pivot = new THREE.Group();
    pivot.name = `${id}-pivot`;
    // The admitted plate keeps each ring beside the wrist/upper-thigh gap,
    // not beside the waistline.  Use a smaller shared diameter so the rings
    // remain an accessory to the pose instead of defining the silhouette.
    pivot.position.set(x + Math.sign(x) * 0.05, 3.14, 0.10);
    ringsRoot.add(pivot);
    nodes[pivot.name] = pivot;
    const radius = 0.47;
    const ring = makePart(root, nodes, meshes, id, new THREE.TorusGeometry(radius, 0.052, 8, 28), gold, {
      parent: pivot,
      role: 'sonic-energy-ring',
      level: 'meso',
      // The admitted front plate shows both rings as oblique ellipses beside
      // the hands. Rotate the torus in its screen plane; radius and pivot stay
      // fixed so this pass tests orientation rather than compensating for an
      // arm-length or framing error.
      rotation: [0.12, 0.88 * Math.sign(x), 0.42 * Math.sign(x)],
      castShadow: false,
      receiveShadow: false,
    });
    ring.traverse((object) => {
      object.userData.excludeFromCaptureBounds = true;
    });
    addDetail(ring, new THREE.TorusGeometry(radius, 0.018, 5, 24), goldBright);
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.90, 20),
      new THREE.MeshStandardMaterial({
        color: PALETTE.gold,
        emissive: PALETTE.gold,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        flatShading: true,
        metalness: 0.4,
        roughness: 0.4,
      }),
    );
    core.name = '';
    core.userData.explodeWithParent = true;
    core.userData.excludeFromCaptureBounds = true;
    ring.add(core);
    return pivot;
  };
  const ringL = makeRing('ring-l', 1.44);
  const ringR = makeRing('ring-r', -1.44);

  // ── Runtime contract, sockets, destruction groups ─────────────────────────
  for (const [name, object] of Object.entries(nodes)) {
    if (!name.startsWith('pivot-')) continue;
    const socket = new THREE.Object3D();
    socket.name = `${name}-socket`;
    object.add(socket);
    sockets[socket.name] = socket;
  }
  const tris = triangleCount(root);
  root.userData.sculptRuntime = {
    blueprint: LEE_SIN_BLUEPRINT,
    architecture: {
      masterSkills: [
        'character-blueprint',
        'character-anatomy',
        'character-geometry',
        'character-surface',
        'character-rig-deformation',
        'character-hair',
        'character-clothing',
        'character-validation',
      ],
      implemented: {
        blueprint: 'landmarks/proportions/cross-sections attached to runtime',
        anatomy: 'continuous torso-arm envelope plus closed head/neck sections',
        geometry: 'indexed watertight section-grid with semanticRegion and skin attributes',
        surface: 'independent pigment material on closed skin-bound vector marks with UV anchors, surface normals, zones, and shared weights',
        rigDeformation: 'named pivots, bones, weights, sockets, rest-pose tick contract',
        hair: 'opaque scalp cap, tapered volumetric locks, rigid parent, LOD metadata',
        clothing: 'closed sash/pants/wrap/foot components, garment refinement pending',
        validation: 'fresh primary/orbit capture, Tier1, topology probe, runtime readiness',
      },
      gate: 'placeholder-until-silhouette-and-regional-review-pass',
    },
    nodes,
    meshes,
    sockets,
    colliders: {},
    hairLod,
    hairMotion: {
      mode: 'local-rigid-pivot',
      locks: ['hair-topknot', 'hair-trailing-lock-upper', 'hair-trailing-lock-lower'],
      rebuiltPerFrame: false,
      restPoseFrozenForCapture: true,
    },
    destructionGroups: {
      head: ['head', 'blindfold', 'blindfold-knot', 'blindfold-ribbon-a', 'blindfold-ribbon-b', 'hair-scalp-cap', 'hair-topknot', 'hair-lock-l1', 'hair-lock-l2', 'hair-lock-r1', 'hair-lock-r2', 'hair-lock-back', 'hair-crown', 'hair-scalp-left', 'hair-scalp-right', 'hair-side-swept-left', 'hair-trailing-lock-upper', 'hair-trailing-lock-lower'],
      torso: ['torso', 'integrated-pectoral-l', 'integrated-pectoral-r', 'chest-tattoo', 'sash', 'sash-diagonal-front', 'sash-diagonal-hip', 'pants-hips'],
      armL: ['shoulder-cap-l', 'clavicle-l', 'upper-arm-l', 'elbow-l', 'forearm-l', 'forearm-wrap-l', 'wrist-wrap-l', 'hand-l'],
      armR: ['shoulder-cap-r', 'clavicle-r', 'upper-arm-r', 'gold-armband-r', 'elbow-r', 'forearm-r', 'forearm-wrap-r', 'wrist-wrap-r', 'hand-r'],
      legL: ['thigh-l', 'pants-hem-l', 'thigh-wrap-l', 'shin-l', 'knee-l', 'ankle-wrap-l', 'foot-l'],
      legR: ['thigh-r', 'pants-hem-r', 'thigh-wrap-r', 'shin-r', 'knee-r', 'ankle-wrap-r', 'foot-r'],
      rings: ['ring-l', 'ring-r'],
    },
    provenance: {
      subject: 'Lee Sin',
      reference: 'public/references/lee-sin.jpg',
      style: 'stylized-lean-low-poly-martial-artist',
      triangleCount: tris,
      pipeline: 'img2threejs-showcase hand-authored procedural character rebuild',
    },
    honesty: {
      singleViewLimit: true,
      hiddenSidesInferred: ['back-of-head hair volume', 'rear belt wrap', 'sole tread'],
      fidelityClaim: 'macro silhouette rebuild in progress; decorative identity pass is intentionally deferred',
    },
  };

  const breathBase = chest.scale.clone();
  const topknotBase = topknot.position.clone();
  const ringLBase = ringL.position.clone();
  const ringRBase = ringR.position.clone();
  const spineBaseY = spine.rotation.y;
  const lShoulderZ = leftArm.shoulder.rotation.z;
  const rShoulderZ = rightArm.shoulder.rotation.z;
  const lHipX = leftLeg.hip.rotation.x;
  const rHipX = rightLeg.hip.rotation.x;

  const tick = (_dt: number, elapsed: number): void => {
    if (!animate) return;
    const t = elapsed;
    const breath = 1 + Math.sin(t * 1.7) * 0.018;
    chest.scale.set(breathBase.x * breath, breathBase.y * (1 + Math.sin(t * 1.7) * 0.012), breathBase.z * breath);
    pelvis.rotation.y = Math.sin(t * 0.55) * 0.04;
    spine.rotation.y = spineBaseY + Math.sin(t * 0.7) * 0.03;
    spine.rotation.x = Math.sin(t * 0.9) * 0.02;
    headPivot.rotation.y = Math.sin(t * 0.45) * 0.06;
    headPivot.rotation.x = Math.sin(t * 0.6) * 0.025;
    leftArm.shoulder.rotation.z = lShoulderZ + Math.sin(t * 1.1) * 0.04;
    rightArm.shoulder.rotation.z = rShoulderZ + Math.sin(t * 1.1 + 0.4) * 0.04;
    leftArm.elbow.rotation.x = Math.sin(t * 1.3) * 0.06;
    rightArm.elbow.rotation.x = Math.sin(t * 1.3 + 0.5) * 0.06;
    leftLeg.hip.rotation.x = lHipX + Math.sin(t * 1.7) * 0.02;
    rightLeg.hip.rotation.x = rHipX + Math.sin(t * 1.7 + Math.PI) * 0.02;
    topknot.position.y = topknotBase.y + Math.sin(t * 1.7) * 0.015;
    topknot.rotation.z = Math.sin(t * 1.2) * 0.04;
    trailingHairUpper.rotation.z = trailingHairUpperBaseZ + Math.sin(t * 1.15 + 0.35) * 0.035;
    trailingHairLower.rotation.z = trailingHairLowerBaseZ + Math.sin(t * 1.15 + 0.85) * 0.045;
    const pulse = 1 + Math.sin(t * 2.4) * 0.06;
    ringL.rotation.z = t * 0.7;
    ringR.rotation.z = -t * 0.7;
    ringL.rotation.y = t * 0.35;
    ringR.rotation.y = -t * 0.35;
    ringL.scale.setScalar(pulse);
    ringR.scale.setScalar(pulse);
    ringL.position.y = ringLBase.y + Math.sin(t * 1.5) * 0.08;
    ringR.position.y = ringRBase.y + Math.sin(t * 1.5 + 1.0) * 0.08;
    ringL.position.x = ringLBase.x + Math.sin(t * 0.8) * 0.04;
    ringR.position.x = ringRBase.x - Math.sin(t * 0.8) * 0.04;
    const emissive = 0.12 + (Math.sin(t * 2.4) * 0.5 + 0.5) * 0.18;
    gold.emissiveIntensity = emissive;
    goldBright.emissiveIntensity = 0.20 + emissive;
  };

  root.userData.tick = tick;
  tick(0, 0);
  root.rotation.y = 0;
  return root;
}
