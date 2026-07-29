import * as THREE from 'three';

/**
 * PS5 DualSense Wireless Controller — procedural Three.js reconstruction.
 *
 * Architecture:
 *   White shells = DOMINANT surface (thin 3D plates covering entire top face)
 *   Black chassis = RECESSED, sits INSIDE/BELOW white shells
 *   Handles = thick tapered volumes flaring outward 15-20°, organic wings
 *   Horns = white shell ridges framing the touchpad area
 */

export interface Ps5DualSenseOptions {
  shadows?: boolean;
  animate?: boolean;
}

/* ── Palette ─────────────────────────────────────────────────────────── */

const WHITE_SHELL = 0xe8e4e0;
const BLACK_INNER = 0x1a1a1a;
const THUMBSTICK_RUBBER = 0x111111;
const BLUE_RING = 0x1a5ccc;
const BUTTON_CLEAR = 0xcccccc;
const TOUCHPAD_COLOR = 0xd0ccc8;
const TRIGGER_BLACK = 0x0d0d0d;

/* ── Materials ───────────────────────────────────────────────────────── */

function makeMaterials() {
  return {
    whiteShell: new THREE.MeshPhysicalMaterial({
      color: WHITE_SHELL,
      roughness: 0.85,
      metalness: 0.0,
      clearcoat: 0.1,
      clearcoatRoughness: 0.5,
    }),
    blackInner: new THREE.MeshPhysicalMaterial({
      color: BLACK_INNER,
      roughness: 0.7,
      metalness: 0.0,
      clearcoat: 0.05,
      clearcoatRoughness: 0.6,
    }),
    thumbstickRubber: new THREE.MeshPhysicalMaterial({
      color: THUMBSTICK_RUBBER,
      roughness: 0.9,
      metalness: 0.0,
    }),
    thumbstickBlue: new THREE.MeshPhysicalMaterial({
      color: BLUE_RING,
      roughness: 0.3,
      metalness: 0.1,
      emissive: 0x0a2266,
      emissiveIntensity: 0.4,
    }),
    buttonClear: new THREE.MeshPhysicalMaterial({
      color: BUTTON_CLEAR,
      roughness: 0.15,
      metalness: 0.0,
      transmission: 0.6,
      thickness: 0.5,
      ior: 1.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
    }),
    touchpad: new THREE.MeshPhysicalMaterial({
      color: TOUCHPAD_COLOR,
      roughness: 0.35,
      metalness: 0.0,
      clearcoat: 0.3,
    }),
    trigger: new THREE.MeshPhysicalMaterial({
      color: TRIGGER_BLACK,
      roughness: 0.6,
      metalness: 0.0,
    }),
  };
}

/* ── Butterfly Profile ───────────────────────────────────────────────── */

/**
 * Butterfly-shaped height profile for the DualSense top surface.
 * x ∈ [-0.55, 0.55], returns height y above center.
 *
 * Shape features:
 *   - Highest at shoulder roots (x ≈ ±0.48)
 *   - Horn peaks (x ≈ ±0.38) frame the touchpad
 *   - Center dip (|x| < 0.22) for the touchpad recess
 *   - Tapered outer edges (|x| > 0.48) that flow into handles
 */
function butterflyProfile(x: number): number {
  const ax = Math.abs(x);
  let y = 0.065; // Further refined for even thinner shells

  // Center touchpad recess
  if (ax < 0.22) {
    y -= 0.012 * (1 - ax / 0.22);
  }

  // Horn peaks flanking the touchpad
  if (ax > 0.22 && ax < 0.42) {
    const ht = (ax - 0.22) / 0.20;
    y += 0.02 * Math.sin(ht * Math.PI); // Further refined
  }

  // Shoulder region (broad flat area)
  if (ax >= 0.42 && ax <= 0.52) {
    y += 0.003; // Further refined
  }

  // Taper toward handle attachment
  if (ax > 0.52) {
    const tt = (ax - 0.52) / 0.03;
    y -= 0.012 * tt; // Further refined
  }

  return y;
}

/**
 * Create a thin 3D shell plate from the butterfly profile.
 * Returns a BufferGeometry with proper thickness (2–3 mm scale).
 */
function createShellGeometry(
  ySign: 1 | -1,
  segments = 48,
  shellWidth = 1.10,
  shellDepth = 0.50,
  shellThickness = 0.010, // Further refined for even thinner plates
): THREE.BufferGeometry {
  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  const halfD = shellDepth / 2;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = (t - 0.5) * shellWidth;
    const h = butterflyProfile(x);

    // Top surface
    const ty = ySign * h;
    verts.push(x, ty, halfD);
    norms.push(0, ySign, 0);
    uvs.push(t, 0);

    verts.push(x, ty, -halfD);
    norms.push(0, ySign, 0);
    uvs.push(t, 1);

    // Bottom surface (offset by shell thickness)
    const by = ySign * (h - shellThickness);
    verts.push(x, by, halfD);
    norms.push(0, -ySign, 0);
    uvs.push(t, 0);

    verts.push(x, by, -halfD);
    norms.push(0, -ySign, 0);
    uvs.push(t, 1);
  }

  const stride = 4; // 4 verts per column

  for (let i = 0; i < segments; i++) {
    const base = i * stride;

    // Top surface (facing outward)
    idx.push(base, base + stride, base + stride + 1, base, base + stride + 1, base + 1);

    // Bottom surface (facing inward, reversed winding)
    idx.push(base + 2, base + 3, base + stride + 3, base + 2, base + stride + 3, base + stride + 2);

    // Front cap (z = +halfD)
    idx.push(base, base + 2, base + stride + 2, base, base + stride + 2, base + stride);

    // Back cap (z = -halfD)
    idx.push(base + 1, base + stride + 1, base + stride + 3, base + 1, base + stride + 3, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Create a horn geometry — a wedge that rises from the shell surface
 * to frame the touchpad area.
 */
function createHornGeometry(
  xCenter: number,
  xDir: -1 | 1,
  shellDepth = 0.50,
  segments = 16,
): THREE.BufferGeometry {
  const halfD = shellDepth / 2;
  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = xCenter + xDir * t * 0.08;
    const shellH = butterflyProfile(x);
    const hornH = shellH + 0.012 * Math.sin(t * Math.PI); // Further refined

    // Top of horn
    verts.push(x, hornH, halfD);
    norms.push(0, 1, 0);
    uvs.push(t, 0);

    verts.push(x, hornH, -halfD);
    norms.push(0, 1, 0);
    uvs.push(t, 1);

    // Bottom of horn (= shell surface)
    verts.push(x, shellH, halfD);
    norms.push(0, -1, 0);
    uvs.push(t, 0);

    verts.push(x, shellH, -halfD);
    norms.push(0, -1, 0);
    uvs.push(t, 1);
  }

  const stride = 4;

  for (let i = 0; i < segments; i++) {
    const base = i * stride;

    // Top surface
    idx.push(base, base + stride, base + stride + 1, base, base + stride + 1, base + 1);

    // Bottom surface
    idx.push(base + 2, base + 3, base + stride + 3, base + 2, base + stride + 3, base + stride + 2);

    // Front cap
    idx.push(base, base + 2, base + stride + 2, base, base + stride + 2, base + stride);

    // Back cap
    idx.push(base + 1, base + stride + 1, base + stride + 3, base + 1, base + stride + 3, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Create a handle — thick tapered tube with elliptical cross-section.
 * Flares outward 15–20° from the shoulder, tapers to a thin rounded tip.
 */
function createHandleGeometry(side: -1 | 1): THREE.BufferGeometry {
  const path = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(side * 0.44, 0.04, 0.18), // Further refined to be even closer to body
      new THREE.Vector3(side * 0.50, -0.04, 0.20),
      new THREE.Vector3(side * 0.58, -0.12, 0.21),
      new THREE.Vector3(side * 0.66, -0.22, 0.20),
      new THREE.Vector3(side * 0.72, -0.34, 0.18),
      new THREE.Vector3(side * 0.74, -0.44, 0.15),
      new THREE.Vector3(side * 0.72, -0.54, 0.10),
      new THREE.Vector3(side * 0.66, -0.62, 0.05),
      new THREE.Vector3(side * 0.58, -0.68, 0.00),
      new THREE.Vector3(side * 0.50, -0.72, -0.03),
    ],
    false,
    'catmullrom',
    0.4,
  );

  const tubularSegments = 36;
  const radialSegments = 20;
  const frames = path.computeFrenetFrames(tubularSegments, false);

  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const pos = path.getPointAt(t);
    const N = frames.normals[i];
    const B = frames.binormals[i];

    // Taper: thick at shoulder → thin at tip
    const radius = 0.09 * (1 - t * 0.72); // Further refined from 0.10

    // Asymmetrical elliptical cross-section:
    //   Exterior (side facing away from center) is more rounded
    //   Interior (side facing toward center) is flatter
    const rMajor = radius * 1.25;
    const rMinor = radius * 0.85;

    for (let j = 0; j <= radialSegments; j++) {
      const angle = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);

      // Elliptical radius
      const r = rMajor * rMinor / Math.sqrt(
        (rMinor * cos) ** 2 + (rMajor * sin) ** 2,
      );

      verts.push(
        pos.x + r * cos * N.x + r * sin * B.x,
        pos.y + r * cos * N.y + r * sin * B.y,
        pos.z + r * cos * N.z + r * sin * B.z,
      );
      norms.push(N.x * cos + B.x * sin, N.y * cos + B.y * sin, N.z * cos + B.z * sin);
      uvs.push(t, j / radialSegments);
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (radialSegments + 1) + j;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/* ── Main Model ──────────────────────────────────────────────────────── */

export function createPs5DualSenseModel(
  options: Ps5DualSenseOptions = {},
): THREE.Group {
  const { shadows = true } = options;
  const mats = makeMaterials();
  const g = new THREE.Group();
  g.name = 'ps5DualSense';

  /* ── 1. White top shell (DOMINANT surface, thin 3D plate) ─────────── */
  const topShell = new THREE.Mesh(
    createShellGeometry(1),
    mats.whiteShell,
  );
  topShell.name = 'whiteTopShell';
  topShell.position.y = 0.055; // Further refined for even thinner appearance
  topShell.castShadow = shadows;
  g.add(topShell);

  /* ── 2. White bottom shell (mirrored) ─────────────────────────────── */
  const bottomShell = new THREE.Mesh(
    createShellGeometry(-1),
    mats.whiteShell,
  );
  bottomShell.name = 'whiteBottomShell';
  bottomShell.position.y = -0.055; // Further refined for even thinner appearance
  bottomShell.castShadow = shadows;
  g.add(bottomShell);

  /* ── 3. Horns framing the touchpad ────────────────────────────────── */
  // Left horn — rises from shell surface at x ≈ -0.30 to -0.38
  const hornL = new THREE.Mesh(
    createHornGeometry(-0.30, -1),
    mats.whiteShell,
  );
  hornL.name = 'hornLeft';
  hornL.castShadow = shadows;
  g.add(hornL);

  // Right horn — rises from shell surface at x ≈ +0.30 to +0.38
  const hornR = new THREE.Mesh(
    createHornGeometry(0.30, 1),
    mats.whiteShell,
  );
  hornR.name = 'hornRight';
  hornR.castShadow = shadows;
  g.add(hornR);

  /* ── 4. Black chassis (SMALLER, RECESSED behind white shells) ─────── */
  // Main recessed body — sits between the two white shell layers
  const chassisGeo = new THREE.BoxGeometry(0.78, 0.09, 0.36, 8, 4, 8); // Further refined
  const chassisPos = chassisGeo.attributes.position;
  for (let i = 0; i < chassisPos.count; i++) {
    const x = chassisPos.getX(i);
    const z = chassisPos.getZ(i);
    const xNorm = x / 0.45;
    const zNorm = z / 0.22;

    // Round corners for organic feel
    if (Math.abs(xNorm) > 0.8 && Math.abs(zNorm) > 0.8) {
      const push = 0.02;
      chassisPos.setY(i, chassisPos.getY(i) - push);
    }

    // Taper height toward sides
    const hScale = 1.0 - 0.15 * xNorm * xNorm;
    chassisPos.setY(i, chassisPos.getY(i) * hScale);
  }
  chassisPos.needsUpdate = true;
  chassisGeo.computeVertexNormals();

  const chassis = new THREE.Mesh(chassisGeo, mats.blackInner);
  chassis.name = 'chassis';
  chassis.castShadow = shadows;
  chassis.receiveShadow = shadows;
  g.add(chassis);

  // Black strip visible between the white shell layers (front face recess)
  const blackStrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.80, 0.022, 0.42), // Further refined
    mats.blackInner,
  );
  blackStrip.name = 'blackStrip';
  blackStrip.position.y = 0;
  g.add(blackStrip);

  /* ── 5. Handles (thick organic wings flaring outward 15–20°) ──────── */
  const handlesGroup = new THREE.Group();
  handlesGroup.name = 'handles';

  for (const side of [-1, 1] as const) {
    const hGroup = new THREE.Group();
    hGroup.name = side < 0 ? 'handleL' : 'handleR';

    // Main handle volume — white shell material, tapered elliptical tube
    const handleMesh = new THREE.Mesh(
      createHandleGeometry(side),
      mats.whiteShell,
    );
    handleMesh.name = side < 0 ? 'handleMeshL' : 'handleMeshR';
    handleMesh.castShadow = shadows;
    hGroup.add(handleMesh);

    // Black grip strip running along the inner surface of each handle
    const gripPath = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(side * 0.48, 0.03, 0.22), // Further adjusted for even thinner shells
        new THREE.Vector3(side * 0.54, -0.05, 0.24),
        new THREE.Vector3(side * 0.62, -0.13, 0.25),
        new THREE.Vector3(side * 0.70, -0.23, 0.24),
        new THREE.Vector3(side * 0.76, -0.35, 0.21),
        new THREE.Vector3(side * 0.78, -0.45, 0.17),
        new THREE.Vector3(side * 0.76, -0.55, 0.12),
        new THREE.Vector3(side * 0.70, -0.63, 0.07),
        new THREE.Vector3(side * 0.62, -0.69, 0.02),
        new THREE.Vector3(side * 0.54, -0.73, -0.02),
      ],
      false,
      'catmullrom',
      0.4,
    );

    const gripSegs = 24;
    const gripRadial = 12;
    const gripFrames = gripPath.computeFrenetFrames(gripSegs, false);
    const gVerts: number[] = [];
    const gNorms: number[] = [];
    const gUvs: number[] = [];
    const gIdx: number[] = [];

    for (let i = 0; i <= gripSegs; i++) {
      const t = i / gripSegs;
      const pos = gripPath.getPointAt(t);
      const N = gripFrames.normals[i];
      const B = gripFrames.binormals[i];
      const r = 0.025 * (1 - t * 0.7); // Further reduced from 0.03

      for (let j = 0; j <= gripRadial; j++) {
        const a = (j / gripRadial) * Math.PI * 2;
        gVerts.push(
          pos.x + r * Math.cos(a) * N.x + r * Math.sin(a) * B.x,
          pos.y + r * Math.cos(a) * N.y + r * Math.sin(a) * B.y,
          pos.z + r * Math.cos(a) * N.z + r * Math.sin(a) * B.z,
        );
        gNorms.push(N.x, N.y, N.z);
        gUvs.push(t, j / gripRadial);
      }
    }

    for (let i = 0; i < gripSegs; i++) {
      for (let j = 0; j < gripRadial; j++) {
        const a = i * (gripRadial + 1) + j;
        gIdx.push(a, a + 1, a + gripRadial + 2, a, a + gripRadial + 2, a + gripRadial + 1);
      }
    }

    const gripGeo = new THREE.BufferGeometry();
    gripGeo.setIndex(gIdx);
    gripGeo.setAttribute('position', new THREE.Float32BufferAttribute(gVerts, 3));
    gripGeo.setAttribute('normal', new THREE.Float32BufferAttribute(gNorms, 3));
    gripGeo.setAttribute('uv', new THREE.Float32BufferAttribute(gUvs, 2));
    gripGeo.computeVertexNormals();

    const grip = new THREE.Mesh(gripGeo, mats.blackInner);
    grip.name = side < 0 ? 'gripL' : 'gripR';
    hGroup.add(grip);

    handlesGroup.add(hGroup);
  }
  g.add(handlesGroup);

  /* ── 6. Thumbsticks (seated in circular cutouts) ──────────────────── */
  const thumbstickPositions: [number, number, number][] = [
    [-0.24, 0.09, 0.22], // Further refined for even thinner shells
    [0.24, 0.09, 0.22],
  ];

  thumbstickPositions.forEach(([x, y, z], idx) => {
    const tsGroup = new THREE.Group();
    tsGroup.name = idx === 0 ? 'thumbstickL' : 'thumbstickR';

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.03, 24),
      mats.blackInner,
    );
    base.position.y = -0.015;
    tsGroup.add(base);

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.07, 0.07, 20),
      mats.thumbstickRubber,
    );
    stem.position.y = 0.035;
    tsGroup.add(stem);

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.05, 0.02, 20),
      mats.thumbstickRubber,
    );
    top.position.y = 0.07;
    tsGroup.add(top);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.007, 8, 24),
      mats.thumbstickBlue,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.015;
    tsGroup.add(ring);

    tsGroup.position.set(x, y, z);
    g.add(tsGroup);
  });

  /* ── 7. Touchpad (centered between the horns) ─────────────────────── */
  const touchpadGeo = new THREE.BoxGeometry(0.26, 0.010, 0.18, 4, 1, 4); // Further refined
  const tpPos = touchpadGeo.attributes.position;
  for (let i = 0; i < tpPos.count; i++) {
    const x = tpPos.getX(i);
    const z = tpPos.getZ(i);
    const xNorm = x / 0.16;
    const zNorm = z / 0.125;

    // Slight curve at the front edge
    if (zNorm < -0.7 && Math.abs(xNorm) > 0.6) {
      const off = 0.3 * (1 - Math.sqrt(1 - ((Math.abs(xNorm) - 0.6) / 0.4) ** 2));
      tpPos.setZ(i, z + off * 0.04);
    }
  }
  tpPos.needsUpdate = true;
  touchpadGeo.computeVertexNormals();

  const touchpad = new THREE.Mesh(touchpadGeo, mats.touchpad);
  touchpad.name = 'touchpad';
  touchpad.position.set(0, 0.11, 0.11); // Further refined for even thinner shells
  g.add(touchpad);

  // Click mechanism (dark separator under touchpad)
  const click = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.003, 0.16), // Further refined
    mats.blackInner,
  );
  click.position.set(0, 0.10, 0.11); // Further refined for even thinner shells
  g.add(click);

  /* ── 8. Action buttons (ABXY) ──────────────────────────────────────── */
  const buttonPositions: [number, number, number, string][] = [
    [0.36, 0.09, 0.22, 'triangle'], // Further refined for even thinner shells
    [0.44, 0.03, 0.22, 'circle'],
    [0.36, -0.03, 0.22, 'cross'],
    [0.28, 0.03, 0.22, 'square'],
  ];

  buttonPositions.forEach(([x, y, z, name]) => {
    const btn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.02, 16),
      mats.buttonClear,
    );
    btn.name = `button_${name}`;
    btn.position.set(x, y, z);
    g.add(btn);
  });

  /* ── 9. D-pad ──────────────────────────────────────────────────────── */
  const dpadGroup = new THREE.Group();
  dpadGroup.name = 'dpad';

  dpadGroup.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.02, 0.10),
    mats.blackInner,
  ));

  dpadGroup.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.02, 0.035),
    mats.blackInner,
  ));

  dpadGroup.position.set(-0.36, 0.09, 0.22); // Further refined for even thinner shells
  g.add(dpadGroup);

  /* ── 10. PS button ─────────────────────────────────────────────────── */
  const psBtn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.015, 16),
    mats.buttonClear,
  );
  psBtn.name = 'psButton';
  psBtn.position.set(0, 0.03, 0.24); // Further refined for even thinner shells
  g.add(psBtn);

  /* ── 11. Create / Options buttons ──────────────────────────────────── */
  const createBtn = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.015, 0.025),
    mats.blackInner,
  );
  createBtn.name = 'createButton';
  createBtn.position.set(-0.11, 0.11, 0.24); // Further refined for even thinner shells
  g.add(createBtn);

  const optionsBtn = createBtn.clone();
  optionsBtn.name = 'optionsButton';
  optionsBtn.position.set(0.12, 0.12, 0.26); // Further adjusted for even thinner shells
  g.add(optionsBtn);

  /* ── 12. Triggers (L1/R1 bumpers, L2/R2 adaptive triggers) ────────── */
  for (const side of [-1, 1] as const) {
    const bumper = new THREE.Mesh(
      new THREE.BoxGeometry(0.20, 0.035, 0.10),
      mats.trigger,
    );
    bumper.name = side < 0 ? 'bumperL' : 'bumperR';
    bumper.position.set(side * 0.40, 0.12, -0.20); // Further adjusted for even thinner shells
    bumper.rotation.x = -0.2;
    g.add(bumper);

    const triggerGeo = new THREE.BoxGeometry(0.18, 0.025, 0.13, 4, 1, 4);
    const trigPos = triggerGeo.attributes.position;
    for (let i = 0; i < trigPos.count; i++) {
      const z = trigPos.getZ(i);
      const zNorm = z / 0.065;
      trigPos.setY(i, trigPos.getY(i) + zNorm * zNorm * 0.015);
    }
    trigPos.needsUpdate = true;
    triggerGeo.computeVertexNormals();

    const trigger = new THREE.Mesh(triggerGeo, mats.trigger);
    trigger.name = side < 0 ? 'triggerL' : 'triggerR';
    trigger.position.set(side * 0.40, 0.08, -0.30); // Further adjusted for even thinner shells
    trigger.rotation.x = -0.3;
    g.add(trigger);
  }

  /* ── 13. Speaker grille ────────────────────────────────────────────── */
  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.005, 0.05),
    mats.blackInner,
  );
  grille.name = 'speakerGrille';
  grille.position.set(0, 0.03, -0.08); // Further adjusted for even thinner shells
  g.add(grille);

  /* ── 14. USB-C port ────────────────────────────────────────────────── */
  const usb = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.02, 0.025),
    mats.blackInner,
  );
  usb.name = 'usbPort';
  usb.position.set(0, 0.08, -0.26); // Further adjusted for even thinner shells
  g.add(usb);

  /* ── 15. Microphone LED strip ──────────────────────────────────────── */
  const mic = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.007, 0.018),
    mats.thumbstickBlue,
  );
  mic.name = 'micLed';
  mic.position.set(0, 0.03, -0.04); // Further adjusted for even thinner shells
  g.add(mic);

  return g;
}

/* ── Background ──────────────────────────────────────────────────────── */

export function makePs5Background(): THREE.Color {
  return new THREE.Color(0xe8e8e8);
}

/* ── Look Dev Lights ─────────────────────────────────────────────────── */

export function createPs5DualSenseLookDevLights(): THREE.Group {
  const g = new THREE.Group();

  const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
  key.position.set(-2, 4, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 3;
  key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.0004;

  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.8);
  fill.position.set(3, 1, 2.5);

  const rim = new THREE.DirectionalLight(0x8fb6ff, 1.6);
  rim.position.set(1, -1.5, -4);

  g.add(key, fill, rim, new THREE.AmbientLight(0x223344, 0.4));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ opacity: 0.4 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.45;
  ground.receiveShadow = true;
  g.add(ground);

  return g;
}
