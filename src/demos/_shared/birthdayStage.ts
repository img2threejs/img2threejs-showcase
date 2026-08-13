import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * BIRTHDAY STAGE — the shared celebration set: a three-tier crystalline cake, a holographic halo,
 * and a twelve-family prop field, plus the procedural helpers and look-dev rig they need.
 *
 * Extracted from the original birthday-robot demo so a different character can stand on the same
 * stage. Everything here is character-agnostic: nothing in this file knows or cares what is
 * standing on the cake.
 *
 * PROVENANCE: this set was authored SPEC-ONLY from a written art-direction brief, with no reference
 * image. The palette and prop placement are authored design choices, not matches to any artwork.
 * See work/birthday-robot-README.md for the full record, including the eight defects that review
 * caught and the residual self-intersection finding.
 *
 * All scatter uses a seeded PRNG, so every layout here is deterministic and reproducible.
 */

// --------------------------------------------------------------------------- palette
const JOINT_METAL = 0x96a2b2;
const GLOW_CYAN = 0x7ef0ff;
const SPONGE = 0xf8e2ba;
const FROST = 0xa8ddff;
const NEON = 0xff5cbe;
const WAX = 0xfff2e0;
const FLAME = 0xffd682;
const STAR = 0xffe278;
const HOLO = 0x78d6ff;
const BOOK = 0xc66a5c;
const PAPER = 0xf8f8f4;
// Dark enough to sit UNDER the backdrop gradient rather than glow against it — a light floor
// here reads as fog and kills the contrast the whole scene depends on.
const GROUND = 0x1b2540;

const BALLOON_TINTS = [0xff606c, 0x7e94ff, 0xffce5c, 0x40c4d0, 0xff5cbe, 0x8ce06a, 0xffa14a];
const GIFT_TINTS = [0x7e94ff, 0xff5cbe, 0xffce5c, 0x40c4d0, 0xff8a5c];
const CONFETTI_TINTS = [0xff5cbe, 0xffce5c, 0x40c4d0, 0x7e94ff, 0x8ce06a];

// ---------------------------------------------------------------------------
// layout spine — the numbers the spec pins down

/** Top surface of the cake — the plane a character's feet seat on. */
export const CAKE_TOP_Y = 2.18;
export const HALO_CENTER = new THREE.Vector3(0, 4.55, -2.0);

// --------------------------------------------------------------------------- helpers
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rnd: () => number, lo: number, hi: number) => lo + rnd() * (hi - lo);
export const pick = <T,>(rnd: () => number, list: readonly T[]): T =>
  list[Math.floor(rnd() * list.length) % list.length];

// ---------------------------------------------------------------------------
// material helpers — independent PBR channels, never albedo aliased elsewhere
// ---------------------------------------------------------------------------
export function shell(color: number, roughness = 0.35, clearcoat = 0.6): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0.05,
    clearcoat,
    clearcoatRoughness: 0.08,
  });
}

export function metal(color: number, roughness = 0.35): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.9 });
}

export function matte(color: number, roughness = 0.78): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

export function emissive(color: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.25,
    metalness: 0,
  });
}

function crystal(color: number): THREE.MeshPhysicalMaterial {
  // Transmission + very low roughness is what makes this read as cut crystal rather than icing.
  // Transmission pulled back 0.55 -> 0.38 and the tint pushed cooler: at 0.55 against a bright
  // scene the caps went fully transparent and the tiers lost their frosting silhouette entirely.
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.08,
    metalness: 0,
    transmission: 0.38,
    thickness: 0.3,
    ior: 1.45,
    clearcoat: 0.5,
    transparent: true,
  });
}

export function glossy(color: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.15,
    metalness: 0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
  });
}

/**
 * Holographic material for the halo.
 *
 * Originally emissiveIntensity 1.8 at opacity 0.62, which combined with bloom to render the halo
 * as a solid white glare that engulfed the robot rather than framing him. A hologram has to sit
 * BEHIND the subject in value as well as in depth, so this is deliberately dim: the halo should
 * be the quietest bright thing in the frame, not the loudest.
 */
function holoMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: HOLO,
    emissive: new THREE.Color(HOLO),
    emissiveIntensity: 0.55,
    roughness: 0.25,
    metalness: 0,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
export function bevelBox(w: number, h: number, d: number, radius?: number): THREE.BufferGeometry {
  const r = Math.min(radius ?? 0.05, Math.min(w, h, d) * 0.32);
  return new RoundedBoxGeometry(w, h, d, 3, r);
}

/** Capsule sized by TOTAL height, which is what the spec records. */
export function capsule(radius: number, totalHeight: number): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(radius, Math.max(0.001, totalHeight - radius * 2), 6, 12);
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A limb segment that SPANS two joint positions.
 *
 * Replaces hand-tuned `rotation.z` values, which is how the first pass ended up with a visibly
 * broken arm: rotating a capsule by +0.4rad swings its lower end the opposite way from what the
 * pose needs, so the upper arm's end landed outside the elbow sphere entirely and the limb read as
 * two disconnected pieces. Deriving orientation from the joints makes that class of mistake
 * impossible, and the length overshoot buries both ends inside their joint spheres so no seam
 * shows at either bend.
 */
export function limbBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
  shadows: boolean,
): THREE.Mesh {
  const dir = to.clone().sub(from);
  const span = dir.length();
  const mesh = named(capsule(radius, span + radius * 1.3), material, name, shadows);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  return mesh;
}

export function starShape(outer: number, inner: number, points = 5): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function gearShape(radius: number, teeth: number, toothDepth: number, bore: number): THREE.Shape {
  const s = new THREE.Shape();
  const steps = teeth * 4;
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    // square-ish tooth profile: high for half a tooth period, low for the other half
    const phase = (i / 4) % 1;
    const r = phase < 0.5 ? radius : radius - toothDepth;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, bore, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

function hexShape(radius: number, thickness: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const hole = new THREE.Path();
  const inner = Math.max(0.001, radius - thickness);
  for (let i = 5; i >= 0; i -= 1) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * inner;
    const y = Math.sin(a) * inner;
    if (i === 5) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  hole.closePath();
  s.holes.push(hole);
  return s;
}

/** Teardrop flame: a revolved profile, which a cone cannot describe (it must bulge then taper). */
export function flameGeometry(height: number, maxRadius: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // bulge low, sharp tip high
    const r = Math.sin(Math.pow(t, 0.65) * Math.PI) * maxRadius * (1 - t * 0.35);
    pts.push(new THREE.Vector2(Math.max(0.0005, r), t * height));
  }
  return new THREE.LatheGeometry(pts, 16);
}

export function named(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  shadows: boolean,
  ridesParent = false,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  // Surface relief must ride its shell so explode and part-picking agree on what "a part" is.
  if (ridesParent) mesh.userData.explodeWithParent = true;
  return mesh;
}


// ===========================================================================
// CAKE
// ===========================================================================
interface CakeMats {
  sponge: THREE.Material;
  frost: THREE.Material;
  neon: THREE.Material;
  plate: THREE.Material;
}

function buildTier(
  group: THREE.Group,
  mats: CakeMats,
  index: number,
  radius: number,
  height: number,
  baseY: number,
  frostThickness: number,
  shadows: boolean,
): { topY: number; tier: THREE.Mesh } {
  const tier = named(
    new THREE.CylinderGeometry(radius, radius * 1.01, height, 40),
    mats.sponge,
    `Cake_Tier${index}`,
    shadows,
  );
  tier.position.y = baseY + height / 2;
  group.add(tier);

  // neon icing band piped around the rim, sitting proud of the wall
  const icing = named(
    new THREE.TorusGeometry(radius, 0.03, 8, 44),
    mats.neon,
    `Cake_Icing${index}`,
    shadows,
  );
  icing.rotation.x = Math.PI / 2;
  icing.position.y = baseY + height;
  group.add(icing);

  // bead crowns along the edge — relief, so they ride the icing band
  const beadCount = 32;
  const beads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.028, 8, 6),
    mats.neon,
    beadCount,
  );
  beads.name = `Cake_BeadRow${index}`;
  beads.userData.explodeWithParent = true;
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < beadCount; i += 1) {
    const a = (i / beadCount) * Math.PI * 2;
    m4.makeTranslation(Math.cos(a) * radius, baseY + height + 0.028, Math.sin(a) * radius);
    beads.setMatrixAt(i, m4);
  }
  beads.instanceMatrix.needsUpdate = true;
  group.add(beads);

  // crystalline frosting cap: LOW radial segments so real flat facets survive
  const frostR = radius + 0.06;
  const cap = named(
    new THREE.CylinderGeometry(frostR, frostR * 0.99, frostThickness, 14),
    mats.frost,
    `Cake_Frost${index}`,
    shadows,
  );
  cap.position.y = baseY + height + frostThickness / 2;
  group.add(cap);

  // drip lobes hanging over the tier edge
  const dripCount = 10;
  const drips = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    mats.frost,
    dripCount,
  );
  drips.name = `Cake_Drips${index}`;
  drips.userData.explodeWithParent = true;
  const rnd = mulberry32(700 + index);
  for (let i = 0; i < dripCount; i += 1) {
    const a = (i / dripCount) * Math.PI * 2 + rnd() * 0.3;
    const drop = range(rnd, 0.03, 0.1);
    m4.compose(
      new THREE.Vector3(Math.cos(a) * frostR, baseY + height + frostThickness * 0.3 - drop, Math.sin(a) * frostR),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1.5, 1),
    );
    drips.setMatrixAt(i, m4);
  }
  drips.instanceMatrix.needsUpdate = true;
  group.add(drips);

  return { topY: baseY + height + frostThickness, tier };
}

export function buildCake(shadows: boolean): {
  group: THREE.Group;
  tiers: THREE.Mesh[];
  mats: CakeMats;
} {
  const group = new THREE.Group();
  group.name = 'Cake';

  const mats: CakeMats = {
    sponge: matte(SPONGE, 0.78),
    frost: crystal(FROST),
    neon: emissive(NEON, 1.5),
    plate: metal(JOINT_METAL, 0.35),
  };

  // base plate — sinks 0.02 into the ground disc so no seam or z-fight shows
  const plate = named(
    new THREE.CylinderGeometry(1.75, 1.68, 0.1, 44),
    mats.plate,
    'Cake_Base_Plate',
    shadows,
  );
  plate.position.y = 0.05;
  group.add(plate);

  const t1 = buildTier(group, mats, 1, 1.5, 0.62, 0.1, 0.16, shadows);
  const t2 = buildTier(group, mats, 2, 1.1, 0.55, t1.topY, 0.14, shadows);
  const t3 = buildTier(group, mats, 3, 0.76, 0.48, t2.topY, 0.13, shadows);

  // sprinkles scattered on the top cap, kept clear of the boot footprint
  const rnd = mulberry32(1112);
  const sprinkleCount = 46;
  const sprinkles = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.012, 0.03, 3, 6),
    emissive(NEON, 1.1),
    sprinkleCount,
  );
  sprinkles.name = 'Cake_Sprinkles';
  sprinkles.userData.explodeWithParent = true;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  let placed = 0;
  let guard = 0;
  while (placed < sprinkleCount && guard < sprinkleCount * 20) {
    guard += 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.72;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // skip the boot footprint (|x| < 0.5 and |z| < 0.34) so sprinkles never poke through a sole
    if (Math.abs(x) < 0.5 && Math.abs(z) < 0.34) continue;
    e.set(range(rnd, 0, Math.PI), range(rnd, 0, Math.PI), range(rnd, 0, Math.PI));
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(x, t3.topY + 0.012, z), q, new THREE.Vector3(1, 1, 1));
    sprinkles.setMatrixAt(placed, m4);
    placed += 1;
  }
  sprinkles.count = placed;
  sprinkles.instanceMatrix.needsUpdate = true;
  group.add(sprinkles);

  return { group, tiers: [t1.tier, t2.tier, t3.tier], mats };
}


export function buildHalo(): {
  group: THREE.Group;
  rings: THREE.Mesh[];
  cubes: THREE.Object3D;
  spheres: THREE.Object3D;
} {
  const group = new THREE.Group();
  group.name = 'Halo';
  group.position.copy(HALO_CENTER);

  const mat = holoMaterial();

  // Radii pulled in from 2.4/1.95/1.5: at the old size the outer ring spanned y=1.9..6.7, wrapping
  // the robot's entire upper body so it read as a portal he stood inside rather than a halo behind
  // his head. These frame the head and shoulders instead.
  const rings: THREE.Mesh[] = [];
  const ringSpecs: Array<[string, number, number, number]> = [
    ['Halo_Ring_Outer', 1.85, 0.045, -0.04],
    ['Halo_Ring_Mid', 1.5, 0.033, 0.0],
    ['Halo_Ring_Inner', 1.15, 0.026, 0.04],
  ];
  for (const [name, radius, tube, z] of ringSpecs) {
    const ring = named(new THREE.TorusGeometry(radius, tube, 10, 72), mat, name, false);
    ring.position.z = z;
    if (name === 'Halo_Ring_Mid') ring.rotation.x = 0.12;
    group.add(ring);
    rings.push(ring);
  }

  // tick marks around the outer ring — relief, rides the ring
  const tickCount = 48;
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 0.1, 0.02), mat, tickCount);
  ticks.name = 'Halo_Ring_Ticks';
  ticks.userData.explodeWithParent = true;
  {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; i < tickCount; i += 1) {
      const a = (i / tickCount) * Math.PI * 2;
      e.set(0, 0, a);
      q.setFromEuler(e);
      m4.compose(
        new THREE.Vector3(Math.cos(a) * 1.85, Math.sin(a) * 1.85, -0.04),
        q,
        new THREE.Vector3(1, 1, 1),
      );
      ticks.setMatrixAt(i, m4);
    }
    ticks.instanceMatrix.needsUpdate = true;
  }
  group.add(ticks);

  // hexagonal grid lattice inside the inner ring, fading toward the rim
  const hexGeom = new THREE.ExtrudeGeometry(hexShape(0.135, 0.018), {
    depth: 0.012,
    bevelEnabled: false,
  });
  const hexGroup = new THREE.Group();
  hexGroup.name = 'Halo_HexGrid';
  const step = 0.24;
  const rows = 6;
  for (let row = -rows; row <= rows; row += 1) {
    const yOff = row * step * 0.87;
    const xShift = (row % 2 === 0 ? 0 : step / 2);
    for (let col = -rows; col <= rows; col += 1) {
      const xOff = col * step + xShift;
      const dist = Math.hypot(xOff, yOff);
      if (dist > 1.08) continue;
      const fade = 1 - Math.pow(dist / 1.08, 1.6);
      const cellMat = mat.clone();
      cellMat.opacity = 0.16 + fade * 0.5;
      cellMat.emissiveIntensity = 0.7 + fade * 1.4;
      const cell = named(hexGeom, cellMat, `Halo_Hex_${row}_${col}`, false, true);
      cell.position.set(xOff, yOff, -0.1);
      hexGroup.add(cell);
    }
  }
  group.add(hexGroup);

  // orbiting cubes
  const cubes = new THREE.Group();
  cubes.name = 'Halo_Cube_Ring';
  const rnd = mulberry32(1114);
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    const size = range(rnd, 0.07, 0.14);
    const cube = named(bevelBox(size, size, size, size * 0.16), mat, `Halo_Cube_${i + 1}`, false);
    cube.position.set(Math.cos(a) * 1.62, Math.sin(a) * 1.62, range(rnd, -0.18, 0.18));
    cube.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    cube.userData.phase = rnd() * Math.PI * 2;
    cubes.add(cube);
  }
  group.add(cubes);

  // orbiting spheres on a wider ring
  const spheres = new THREE.Group();
  spheres.name = 'Halo_Sphere_Ring';
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const r = range(rnd, 0.05, 0.09);
    const s = named(new THREE.SphereGeometry(r, 14, 12), mat, `Halo_Sphere_${i + 1}`, false);
    s.position.set(Math.cos(a) * 2.08, Math.sin(a) * 2.08, range(rnd, -0.2, 0.2));
    spheres.add(s);
  }
  group.add(spheres);

  // arc segments adding depth between rings
  for (let i = 0; i < 5; i += 1) {
    const radius = range(rnd, 1.3, 1.98);
    const arc = named(
      new THREE.TorusGeometry(radius, 0.018, 8, 40, range(rnd, 0.5, 1.5)),
      mat,
      `Halo_Arc_${i + 1}`,
      false,
    );
    arc.rotation.z = rnd() * Math.PI * 2;
    arc.position.z = range(rnd, -0.16, 0.16);
    group.add(arc);
  }

  // cyan practical inside the halo, giving the rings self-illumination falloff
  const light = new THREE.PointLight(HOLO, 0.55, 4.5, 2);
  light.name = 'Halo_Light';
  light.position.set(0, 0, 0.2);
  group.add(light);

  return { group, rings, cubes, spheres };
}

// ===========================================================================
// PROP FIELD
// ===========================================================================
/**
 * Placement rule that keeps the brief's "centred, full character visible" promise: props are
 * pushed out of a protected cylinder around the figure, and biased off the halo plane so the
 * lattice never reads as a solid disc behind a prop.
 */

export function protectedSpot(
  rnd: () => number,
  rMin: number,
  rMax: number,
  yMin: number,
  yMax: number,
  /** Hard ceiling on +Z. Large props (balloons, planets) are kept at or behind the subject plane. */
  maxZ = 2.4,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const a = rnd() * Math.PI * 2;
    const r = range(rnd, rMin, rMax);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = range(rnd, yMin, yMax);
    if (z > maxZ) continue;

    const nearFigure = Math.hypot(x, z) < 2.0 && y < 5.5;
    const onHaloPlane = z < -1.5 && z > -2.5 && Math.hypot(x, y - HALO_CENTER.y) < 2.1;

    // The guard that the first pass was missing. World-space radius is NOT enough: a prop at
    // z=+4 is four units closer to the camera than the robot, so perspective blows it up and it
    // covers the subject even though it is "far away" in XZ. A big orange planet landed square on
    // the robot's chest that way. Anything in the front hemisphere must therefore be pushed
    // sideways in proportion to how close it is, which keeps the centre of frame clear.
    const inFrontCone = z > 0 && Math.abs(x) < 1.9 + z * 0.42;

    if (!nearFigure && !onHaloPlane && !inFrontCone) return new THREE.Vector3(x, y, z);
  }
  // Deterministic placement when sampling fails: out to the side and behind, where nothing
  // it could occlude lives.
  return new THREE.Vector3(rMax * (rnd() < 0.5 ? -1 : 1), range(rnd, yMin, yMax), -rMax * 0.4);
}

export function buildProps(shadows: boolean, lightweight: boolean): {
  group: THREE.Group;
  balloons: THREE.Group;
  confetti: THREE.InstancedMesh;
  particles: THREE.Points;
  airplanes: THREE.Group;
  orbiters: THREE.Object3D[];
} {
  const group = new THREE.Group();
  group.name = 'PropField';
  const orbiters: THREE.Object3D[] = [];

  // ---- balloons ----
  const balloons = new THREE.Group();
  balloons.name = 'Prop_Balloons';
  {
    const rnd = mulberry32(1101);
    for (let i = 0; i < 7; i += 1) {
      const b = new THREE.Group();
      b.name = `Prop_Balloon_${i + 1}`;
      const tint = pick(rnd, BALLOON_TINTS);
      const mat = glossy(tint);
      const r = range(rnd, 0.22, 0.34);
      const body = named(new THREE.SphereGeometry(r, 20, 16), mat, `Balloon_Body_${i + 1}`, shadows);
      body.scale.set(1, 1.18, 1);
      b.add(body);
      const knot = named(
        new THREE.ConeGeometry(r * 0.22, r * 0.3, 10),
        mat,
        `Balloon_Knot_${i + 1}`,
        shadows,
        true,
      );
      knot.position.y = -r * 1.24;
      knot.rotation.x = Math.PI;
      b.add(knot);
      // tether strand
      const strandLen = range(rnd, 0.7, 1.5);
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -r * 1.35, 0),
        new THREE.Vector3(range(rnd, -0.1, 0.1), -r * 1.35 - strandLen * 0.5, range(rnd, -0.1, 0.1)),
        new THREE.Vector3(range(rnd, -0.16, 0.16), -r * 1.35 - strandLen, range(rnd, -0.16, 0.16)),
      ]);
      const strand = named(
        new THREE.TubeGeometry(curve, 14, 0.006, 5, false),
        matte(0xffffff, 0.7),
        `Balloon_String_${i + 1}`,
        false,
        true,
      );
      b.add(strand);
      b.position.copy(protectedSpot(rnd, 2.8, 4.2, 3.6, 6.0, 0.6));
      b.userData.phase = rnd() * Math.PI * 2;
      b.userData.rest = b.position.clone();
      balloons.add(b);
      orbiters.push(b);
    }
  }
  group.add(balloons);

  // ---- gift boxes on a ground ring, with a gap at the front azimuth ----
  {
    const rnd = mulberry32(1102);
    const gifts = new THREE.Group();
    gifts.name = 'Prop_Gifts';
    for (let i = 0; i < 5; i += 1) {
      // spread over the rear 300deg so nothing blocks the cake base from the hero camera
      const a = Math.PI * 0.35 + (i / 5) * Math.PI * 1.62 + range(rnd, -0.1, 0.1);
      const r = range(rnd, 2.2, 3.1);
      const s = range(rnd, 0.34, 0.52);
      const tint = pick(rnd, GIFT_TINTS);
      const paper = matte(tint, 0.5);
      const ribbonMat = new THREE.MeshPhysicalMaterial({
        color: 0xffce5c,
        roughness: 0.28,
        clearcoat: 0.3,
      });
      const g = new THREE.Group();
      g.name = `Prop_Gift_${i + 1}`;
      const box = named(bevelBox(s, s * 0.8, s, s * 0.06), paper, `Gift_Box_${i + 1}`, shadows);
      box.position.y = s * 0.4;
      g.add(box);
      const lid = named(
        bevelBox(s * 1.08, s * 0.16, s * 1.08, s * 0.05),
        paper,
        `Gift_Lid_${i + 1}`,
        shadows,
      );
      lid.position.y = s * 0.86;
      g.add(lid);
      for (const rot of [0, Math.PI / 2]) {
        const strap = named(
          new THREE.BoxGeometry(s * 0.12, s * 1.02, s * 1.14),
          ribbonMat,
          `Gift_Strap_${i + 1}_${rot === 0 ? 'A' : 'B'}`,
          shadows,
          true,
        );
        strap.position.y = s * 0.45;
        strap.rotation.y = rot;
        g.add(strap);
      }
      const bow = named(
        new THREE.TorusKnotGeometry(s * 0.12, s * 0.04, 48, 6),
        ribbonMat,
        `Gift_Bow_${i + 1}`,
        shadows,
        true,
      );
      bow.position.y = s * 0.99;
      g.add(bow);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.rotation.y = rnd() * Math.PI * 2;
      gifts.add(g);
    }
    group.add(gifts);
  }

  // ---- floating stars ----
  {
    const rnd = mulberry32(1103);
    const stars = new THREE.Group();
    stars.name = 'Prop_Stars';
    const mat = new THREE.MeshStandardMaterial({
      color: STAR,
      emissive: new THREE.Color(STAR),
      emissiveIntensity: 2.0,
      roughness: 0.25,
      metalness: 0.5,
    });
    for (let i = 0; i < 9; i += 1) {
      const size = range(rnd, 0.1, 0.2);
      // Bevel kept well under the local feature size. At size*0.08 the bevel at each of the
      // star's five INNER points — sharp concave corners — folded through itself, which the
      // self-intersection gate caught on all nine stars. A concave corner can only carry a bevel
      // smaller than the corner's own clearance.
      // Bevel DISABLED, not merely reduced. A star's five inner points are sharp concave
      // corners, and ExtrudeGeometry offsets a bevel along the corner bisector without checking
      // whether the neighbouring walls have room for it — so at every size tried the bevel folded
      // through itself there, which the self-intersection gate flagged on all nine stars. The
      // extrude depth plus a half-metal material carries the edge highlight instead.
      const geom = new THREE.ExtrudeGeometry(starShape(size, size * 0.44), {
        depth: size * 0.3,
        bevelEnabled: false,
      });
      const star = named(geom, mat, `Prop_Star_${i + 1}`, false);
      star.position.copy(protectedSpot(rnd, 2.6, 4.4, 1.6, 6.0));
      star.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      star.userData.phase = rnd() * Math.PI * 2;
      star.userData.rest = star.position.clone();
      stars.add(star);
      orbiters.push(star);
    }
    group.add(stars);
  }

  // ---- tiny planets ----
  {
    const rnd = mulberry32(1104);
    const planets = new THREE.Group();
    planets.name = 'Prop_Planets';
    for (let i = 0; i < 3; i += 1) {
      const p = new THREE.Group();
      p.name = `Prop_Planet_${i + 1}`;
      const r = range(rnd, 0.16, 0.26);
      const tint = pick(rnd, [0x40c4d0, 0xff8a5c, 0x9e7cff]);
      const body = named(
        new THREE.SphereGeometry(r, 20, 16),
        shell(tint, 0.45, 0.3),
        `Planet_Body_${i + 1}`,
        shadows,
      );
      p.add(body);
      const band = named(
        new THREE.TorusGeometry(r * 0.99, r * 0.1, 8, 28),
        matte(0x000000, 0.7),
        `Planet_Band_${i + 1}`,
        false,
        true,
      );
      band.rotation.x = Math.PI / 2;
      (band.material as THREE.MeshStandardMaterial).color.setHex(tint).multiplyScalar(0.6);
      p.add(band);
      const ring = named(
        new THREE.TorusGeometry(r * 1.7, r * 0.05, 8, 36),
        metal(0xd8dee8, 0.4),
        `Planet_Ring_${i + 1}`,
        false,
      );
      ring.rotation.x = Math.PI / 2 - range(rnd, 0.25, 0.6);
      ring.rotation.z = range(rnd, -0.3, 0.3);
      p.add(ring);
      p.position.copy(protectedSpot(rnd, 3.6, 4.6, 3.0, 5.6, -0.4));
      p.userData.phase = rnd() * Math.PI * 2;
      p.userData.rest = p.position.clone();
      planets.add(p);
      orbiters.push(p);
    }
    group.add(planets);
  }

  // ---- gears ----
  {
    const rnd = mulberry32(1105);
    const gears = new THREE.Group();
    gears.name = 'Prop_Gears';
    const mat = metal(JOINT_METAL, 0.45);
    for (let i = 0; i < 4; i += 1) {
      const radius = range(rnd, 0.16, 0.26);
      // Same concave-corner rule as the stars: every tooth ROOT is a sharp inner corner, so the
      // bevel has to stay small relative to the tooth depth or it self-intersects there.
      // Same reason as the stars: every tooth root is a sharp concave corner with no room for a
      // bevel. Disabled rather than shrunk — a smaller bevel still self-intersected.
      const geom = new THREE.ExtrudeGeometry(
        gearShape(radius, 10, radius * 0.18, radius * 0.24),
        { depth: radius * 0.26, bevelEnabled: false },
      );
      const gear = named(geom, mat, `Prop_Gear_${i + 1}`, shadows);
      gear.position.copy(protectedSpot(rnd, 2.6, 3.8, 1.2, 4.4));
      gear.rotation.set(range(rnd, -0.4, 0.4), range(rnd, -0.4, 0.4), rnd() * Math.PI);
      gear.userData.spin = range(rnd, -0.5, 0.5);
      gear.userData.rest = gear.position.clone();
      gear.userData.phase = rnd() * Math.PI * 2;
      gears.add(gear);
      orbiters.push(gear);
    }
    group.add(gears);
  }

  // ---- books ----
  {
    const rnd = mulberry32(1106);
    const books = new THREE.Group();
    books.name = 'Prop_Books';
    for (let i = 0; i < 3; i += 1) {
      const b = new THREE.Group();
      b.name = `Prop_Book_${i + 1}`;
      const w = range(rnd, 0.24, 0.34);
      const h = range(rnd, 0.3, 0.4);
      const t = range(rnd, 0.07, 0.11);
      const cloth = matte(BOOK, 0.65);
      const cover = named(bevelBox(w, h, t, 0.012), cloth, `Book_Cover_${i + 1}`, shadows);
      b.add(cover);
      const pages = named(
        new THREE.BoxGeometry(w * 0.92, h * 0.92, t * 0.7),
        matte(PAPER, 0.7),
        `Book_Pages_${i + 1}`,
        shadows,
        true,
      );
      pages.position.x = w * 0.03;
      b.add(pages);
      const spine = named(
        new THREE.CylinderGeometry(t * 0.5, t * 0.5, h, 10, 1, false, 0, Math.PI),
        cloth,
        `Book_Spine_${i + 1}`,
        shadows,
        true,
      );
      spine.position.x = -w / 2;
      spine.rotation.z = Math.PI / 2;
      spine.rotation.y = Math.PI / 2;
      b.add(spine);
      b.position.copy(protectedSpot(rnd, 2.4, 3.4, 1.4, 3.6));
      b.rotation.set(range(rnd, -0.5, 0.5), rnd() * Math.PI * 2, range(rnd, -0.4, 0.4));
      b.userData.phase = rnd() * Math.PI * 2;
      b.userData.rest = b.position.clone();
      books.add(b);
      orbiters.push(b);
    }
    group.add(books);
  }

  // ---- paper airplanes ----
  const airplanes = new THREE.Group();
  airplanes.name = 'Prop_Airplanes';
  {
    const rnd = mulberry32(1107);
    const mat = new THREE.MeshStandardMaterial({
      color: PAPER,
      roughness: 0.6,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i += 1) {
      const p = new THREE.Group();
      p.name = `Prop_Airplane_${i + 1}`;
      const s = range(rnd, 0.18, 0.26);
      // two folded wing triangles + a centre crease
      for (const side of [1, -1]) {
        const wing = new THREE.BufferGeometry();
        wing.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            [0, 0, s * 1.6, side * s, 0, -s * 0.5, 0, s * 0.16, -s * 0.4],
            3,
          ),
        );
        wing.computeVertexNormals();
        p.add(named(wing, mat, `Airplane_Wing_${i + 1}_${side > 0 ? 'L' : 'R'}`, false));
      }
      const crease = named(
        new THREE.BoxGeometry(0.006, s * 0.18, s * 1.9),
        mat,
        `Airplane_Crease_${i + 1}`,
        false,
        true,
      );
      crease.position.set(0, s * 0.08, s * 0.55);
      p.add(crease);
      p.position.copy(protectedSpot(rnd, 2.6, 4.0, 2.6, 5.2));
      p.userData.phase = rnd() * Math.PI * 2;
      p.userData.rest = p.position.clone();
      airplanes.add(p);
      orbiters.push(p);
    }
  }
  group.add(airplanes);

  // ---- geometric ornaments ----
  {
    const rnd = mulberry32(1108);
    const orn = new THREE.Group();
    orn.name = 'Prop_Ornaments';
    for (let i = 0; i < 5; i += 1) {
      const r = range(rnd, 0.11, 0.19);
      const geom = i % 2 === 0
        ? new THREE.IcosahedronGeometry(r, 0)
        : new THREE.OctahedronGeometry(r, 0);
      const tint = pick(rnd, [0x40c4d0, 0xff5cbe, 0xffce5c, 0x9e7cff]);
      const o = named(geom, shell(tint, 0.22, 0.8), `Prop_Ornament_${i + 1}`, shadows);
      o.position.copy(protectedSpot(rnd, 2.4, 4.0, 1.0, 5.0));
      o.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      o.userData.phase = rnd() * Math.PI * 2;
      o.userData.rest = o.position.clone();
      orn.add(o);
      orbiters.push(o);
    }
    group.add(orn);
  }

  // ---- ribbon streamers ----
  {
    const rnd = mulberry32(1109);
    const ribbons = new THREE.Group();
    ribbons.name = 'Prop_Ribbons';
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffce5c,
      roughness: 0.28,
      clearcoat: 0.3,
      side: THREE.DoubleSide,
      // Slightly translucent: at full opacity these long tubes read as hard stray lines ruled
      // across the composition rather than as soft streamers behind it.
      transparent: true,
      opacity: 0.72,
    });
    // Radii start at 2.6, not 1.9: at 1.9 the streamers swept straight through the figure and
    // read as stray yellow lines across the robot's chest. protectedSpot() cannot help here
    // because a ribbon is a whole curve, not a point, so the minimum radius does the work.
    for (let i = 0; i < 2; i += 1) {
      const pts: THREE.Vector3[] = [];
      const baseA = rnd() * Math.PI * 2;
      for (let k = 0; k < 5; k += 1) {
        const a = baseA + k * range(rnd, 0.5, 0.9);
        const r = range(rnd, 2.6, 3.9);
        // sin(a) forced negative keeps every control point behind the subject plane
        const z = -Math.abs(Math.sin(a)) * r;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0.4 + k * range(rnd, 0.7, 1.1), z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const ribbon = named(
        new THREE.TubeGeometry(curve, 48, 0.019, 4, false),
        mat,
        `Prop_Ribbon_${i + 1}`,
        false,
      );
      ribbon.scale.z = 1;
      ribbons.add(ribbon);
    }
    group.add(ribbons);
  }

  // ---- confetti ----
  const confettiCount = lightweight ? 40 : 120;
  const confetti = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.045, 0.07),
    new THREE.MeshStandardMaterial({ roughness: 0.5, side: THREE.DoubleSide, vertexColors: true }),
    confettiCount,
  );
  confetti.name = 'Prop_Confetti';
  {
    const rnd = mulberry32(1110);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const color = new THREE.Color();
    for (let i = 0; i < confettiCount; i += 1) {
      const pos = protectedSpot(rnd, 1.2, 4.6, 0.2, 6.4);
      e.set(rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2);
      q.setFromEuler(e);
      m4.compose(pos, q, new THREE.Vector3(1, 1, 1));
      confetti.setMatrixAt(i, m4);
      confetti.setColorAt(i, color.setHex(pick(rnd, CONFETTI_TINTS)));
      confetti.userData[`phase${i}`] = rnd() * Math.PI * 2;
    }
    confetti.instanceMatrix.needsUpdate = true;
    if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
  }
  group.add(confetti);

  // ---- glow particles ----
  const particleCount = lightweight ? 70 : 220;
  const particles = (() => {
    const positions = new Float32Array(particleCount * 3);
    const rnd = mulberry32(1111);
    for (let i = 0; i < particleCount; i += 1) {
      const p = protectedSpot(rnd, 0.8, 5.0, 0.1, 6.6);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: GLOW_CYAN,
      size: 0.05,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const pts = new THREE.Points(geom, mat);
    pts.name = 'Prop_Particles';
    return pts;
  })();
  group.add(particles);

  return { group, balloons, confetti, particles, airplanes, orbiters };
}

// ===========================================================================
// ASSEMBLY
// ===========================================================================

export function createBirthdayStageLookDevLights(): THREE.Group {
  const g = new THREE.Group();

  // Key trimmed 2.1 -> 1.45: at 2.1, combined with the hemisphere fill, the near-white shell and
  // the ground plane both clipped, so the robot had no separation from its own backdrop.
  const key = new THREE.DirectionalLight(0xfff3de, 1.45);
  key.position.set(-5.5, 7.2, 4.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 32;
  const cam = key.shadow.camera as THREE.OrthographicCamera;
  cam.left = -8;
  cam.right = 8;
  cam.top = 9;
  cam.bottom = -3;
  cam.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.radius = 3;
  g.add(key);

  const fill = new THREE.DirectionalLight(0xbbd9ff, 0.32);
  fill.position.set(6.8, 3.0, 5.2);
  g.add(fill);

  // Back-rim: separates the robot silhouette from the halo directly behind it. This is the light
  // doing the most work now that the key is lower — it is what keeps a white robot legible
  // against a bright ring.
  const rim = new THREE.DirectionalLight(0x9ee6ff, 1.5);
  rim.position.set(1.2, 4.2, -9.0);
  g.add(rim);

  // Hemisphere trimmed 0.42 -> 0.2 so shadow cores stay dark and the scene keeps depth.
  g.add(new THREE.HemisphereLight(0xdcf0ff, 0x2a3350, 0.2));
  g.add(new THREE.AmbientLight(0xffffff, 0.03));

  return g;
}

// ---------------------------------------------------------------------------
// plain radial-gradient backdrop — the brief asks for a simple background that
// keeps object boundaries easy to distinguish
// ---------------------------------------------------------------------------
export function makeBirthdayStageBackground(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size * 0.42, size * 0.75);
  grad.addColorStop(0, '#2d4470');
  grad.addColorStop(0.55, '#1d2c4d');
  grad.addColorStop(1, '#111a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}


// ===========================================================================
// GROUND + CANDLE — stage furniture any character on this cake needs
// ===========================================================================

/**
 * Contact-shadow disc. Its ONLY job is stopping the cake from floating.
 *
 * The size and value here are the product of a review defect: at r=9 in a light albedo it rendered
 * as a glowing white plane that filled the lower half of frame and flattened every other value in
 * the scene. Dark and 7 units wide keeps its rim out of a hero frame while staying invisible
 * against the backdrop.
 */
export function buildGround(shadows: boolean): THREE.Mesh {
  const ground = new THREE.Mesh(
    new THREE.CylinderGeometry(7.0, 7.0, 0.02, 64),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1.0, metalness: 0 }),
  );
  ground.name = 'Ground';
  ground.position.y = -0.01; // sunk so it never z-fights the cake plate
  ground.receiveShadow = shadows;
  return ground;
}

export interface CandleParts {
  group: THREE.Group;
  flame: THREE.Mesh;
  sparkles: THREE.InstancedMesh;
  light: THREE.PointLight;
}

/**
 * A held birthday candle, seated at `hand`.
 *
 * Parameterised rather than hard-coded because the original version duplicated the hand position
 * in two functions and they could silently drift apart. The sparkle InstancedMesh is positioned AT
 * the wick with instance offsets RELATIVE to it — baking absolute offsets left the container at the
 * origin, which both reported a nonsense world position to the attachment gate and made
 * `rotation.y` sweep the shards around the whole figure instead of twirling them at the flame.
 */
export function buildCandle(hand: THREE.Vector3, shadows: boolean, bodyHeight = 0.42): CandleParts {
  const g = new THREE.Group();
  g.name = 'Candle';

  const bodyY = hand.y + bodyHeight * 0.62;
  const body = named(
    new THREE.CylinderGeometry(0.026, 0.026, bodyHeight, 16),
    matte(WAX, 0.55),
    'Candle_Body',
    shadows,
  );
  body.position.set(hand.x, bodyY, hand.z);
  g.add(body);

  const stripe = named(
    new THREE.TorusGeometry(0.028, 0.005, 6, 26),
    matte(NEON, 0.5),
    'Candle_Stripe',
    shadows,
    true,
  );
  stripe.rotation.x = Math.PI / 2.4;
  stripe.position.copy(body.position);
  g.add(stripe);

  const wickY = bodyY + bodyHeight / 2;
  const flame = named(flameGeometry(0.15, 0.04), emissive(FLAME, 3.0), 'Candle_Flame', false);
  flame.position.set(hand.x, wickY, hand.z);
  g.add(flame);

  const core = named(
    flameGeometry(0.09, 0.021),
    new THREE.MeshBasicMaterial({ color: 0xfff4d0 }),
    'Candle_Flame_Core',
    false,
    true,
  );
  core.position.set(hand.x, wickY + 0.012, hand.z);
  g.add(core);

  const shardCount = 12;
  const sparkles = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.006, 0.05, 0.006),
    emissive(STAR, 2.4),
    shardCount,
  );
  sparkles.name = 'Candle_Sparkle';
  sparkles.position.set(hand.x, wickY + 0.07, hand.z);
  const rnd = mulberry32(1120);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < shardCount; i += 1) {
    const a = (i / shardCount) * Math.PI * 2 + rnd() * 0.4;
    const r = range(rnd, 0.055, 0.12);
    const y = range(rnd, -0.02, 0.1);
    e.set(range(rnd, -1, 1), a, a);
    q.setFromEuler(e);
    m4.compose(
      new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r),
      q,
      new THREE.Vector3(1, range(rnd, 0.6, 1.4), 1),
    );
    sparkles.setMatrixAt(i, m4);
  }
  sparkles.instanceMatrix.needsUpdate = true;
  g.add(sparkles);

  const light = new THREE.PointLight(0xffc878, 1.1, 2.2, 2);
  light.name = 'Candle_Light';
  light.position.set(hand.x, wickY + 0.07, hand.z);
  g.add(light);

  return { group: g, flame, sparkles, light };
}
