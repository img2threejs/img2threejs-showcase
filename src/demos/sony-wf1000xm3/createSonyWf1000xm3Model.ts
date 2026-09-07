import * as THREE from 'three';

/**
 * Sony WF-1000XM3 true-wireless earbuds + charging case, rebuilt in code from a
 * single studio reference set. Focus: colour & linework fidelity — matte-black
 * stadium case, polished rose-gold/copper lid with an engraved SONY wordmark, a
 * black inner lid (copper rim + engraved spec text), satin-graphite earbuds with
 * copper SONY text + copper mic ring, gold pogo contacts, and L/R + NFC marks.
 *
 * Live animation (looping ~11s): open lid → both buds rise while the case tilts →
 * each bud spins a full turn → buds settle back into the wells → lid closes.
 */

export interface SonyWf1000xm3Options {
  shadows?: boolean;
}

/* ---- palette (measured from the reference) ---- */
const COL = {
  bodyBlack: 0x1b1b1e,
  budBlack: 0x212124,
  innerBlack: 0x141416,
  copper: 0xe3b184,
  copperDark: 0x8f643f,
  copperText: 0xd79a68,
  gold: 0xc9a24b,
  red: 0xd23a34,
  greyLabel: 0xb9b9bc,
  silicone: 0x171719,
  specText: 0xbdb3a6,
};

/* ---- dimensions ---- */
const CASE_LEN = 2.62;
const CASE_DEP = 1.12;
const R = CASE_DEP / 2; // full stadium ends
const BODY_H = 0.92;
const LID_H = 0.4;
const WELL_X = 0.62;
const topY = BODY_H;

/* ============================================================ */
/* texture helpers                                              */
/* ============================================================ */
function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function textTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w = 512,
  h = 256,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Tracked-out text char-by-char (letterSpacing is unreliable across engines). */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  font: string,
  color: string,
  track: number,
): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x + widths[i] / 2, cy);
    x += widths[i] + track;
  }
}

function markerTex(letter: string, ringColor: string, textColor: string): THREE.CanvasTexture {
  return textTexture(
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 14;
      ctx.strokeStyle = ringColor;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, h / 2 - 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.font = '700 130px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, w / 2, h / 2 + 6);
    },
    256,
    256,
  );
}

function decal(tex: THREE.Texture, w: number, h: number): THREE.Mesh {
  const m = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

/* ============================================================ */
/* geometry helpers                                            */
/* ============================================================ */
function stadiumShape(len: number, depth: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hx = len / 2 - r;
  const hz = depth / 2 - r;
  s.absarc(-hx, -hz, r, Math.PI, Math.PI * 1.5);
  s.absarc(hx, -hz, r, Math.PI * 1.5, 0);
  s.absarc(hx, hz, r, 0, Math.PI * 0.5);
  s.absarc(-hx, hz, r, Math.PI * 0.5, Math.PI);
  return s;
}

function stadiumSlab(
  len: number,
  depth: number,
  height: number,
  r: number,
  mat: THREE.Material,
  bevel: number,
  shadows: boolean,
): THREE.Mesh {
  const shape = stadiumShape(len, depth, r);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 36,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

interface HoleSpec {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Extruded stadium deck with genuine oval holes — real well openings, no CSG. */
function piercedDeck(
  len: number,
  depth: number,
  height: number,
  r: number,
  holes: HoleSpec[],
  mat: THREE.Material,
  bevel: number,
  shadows: boolean,
): THREE.Mesh {
  const shape = stadiumShape(len, depth, r);
  for (const h of holes) {
    const p = new THREE.Path();
    p.absellipse(h.cx, h.cy, h.rx, h.ry, 0, Math.PI * 2, false, 0);
    shape.holes.push(p);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 48,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

/* well pocket dimensions (shared by the pierced deck and the well contents) */
const WELL_RX = 0.33;
const WELL_RZ = 0.45;
const WELL_FLOOR_Y = 0.5;

/* ============================================================ */
/* model                                                       */
/* ============================================================ */
export function createSonyWf1000xm3Model(options: SonyWf1000xm3Options = {}): THREE.Group {
  const shadows = options.shadows ?? true;
  const root = new THREE.Group();
  root.name = 'sonyWf1000xm3Set';
  root.position.y = 0.16; // hover so the tilt never clips the contact-shadow plane
  const caseGroup = new THREE.Group();
  caseGroup.name = 'chargingCase';
  root.add(caseGroup);

  /* ---- materials ---- */
  const matBody = new THREE.MeshPhysicalMaterial({
    color: COL.bodyBlack,
    roughness: 0.62,
    metalness: 0.04,
    clearcoat: 0.14,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.4,
  });
  const matBud = new THREE.MeshPhysicalMaterial({
    color: COL.budBlack,
    roughness: 0.52,
    metalness: 0.05,
    clearcoat: 0.45,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.55,
  });
  const matInner = new THREE.MeshPhysicalMaterial({
    color: COL.innerBlack,
    roughness: 0.7,
    metalness: 0.05,
  });
  const matCopper = new THREE.MeshPhysicalMaterial({
    color: COL.copper,
    roughness: 0.16,
    metalness: 1.0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.5,
  });
  const matGold = new THREE.MeshStandardMaterial({ color: COL.gold, roughness: 0.32, metalness: 1.0 });
  const matContactSilver = new THREE.MeshStandardMaterial({
    color: 0xbfc0c4,
    roughness: 0.42,
    metalness: 1.0,
  });
  const matRed = new THREE.MeshStandardMaterial({ color: COL.red, roughness: 0.5, metalness: 0.0 });
  const matSilicone = new THREE.MeshPhysicalMaterial({
    color: COL.silicone,
    roughness: 0.9,
    metalness: 0.0,
    sheen: 0.5,
    sheenColor: new THREE.Color(0x000000),
  });

  /* ---- textures ---- */
  const texLidSony = textTexture((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    drawTracked(ctx, 'SONY', w / 2, h / 2, '700 100px Arial, sans-serif', hex(COL.copperDark), 14);
  });
  const texBudSony = textTexture(
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      drawTracked(ctx, 'SONY', w / 2, h / 2, '700 120px Georgia, serif', hex(COL.copperText), 4);
    },
    512,
    200,
  );
  const texSpec = textTexture(
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = hex(COL.specText);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 34px Arial';
      ctx.fillText('WF-1000XM3R', w / 2, 60);
      ctx.font = '600 24px Arial';
      ctx.fillText('BC-WF1000XM3', w / 2, 96);
      ctx.font = '400 22px Arial';
      ctx.fillText('BC-WF1000XM3  也洁 廬同  語避的|  讓和較中加   輸入 : 5V ⎓ 5004786', w / 2, 150);
    },
    1024,
    220,
  );
  const texNFC = textTexture(
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#e6e6e6';
      ctx.strokeStyle = '#e6e6e6';
      ctx.lineWidth = 10;
      ctx.strokeRect(24, 24, w - 48, h - 48);
      ctx.font = '700 150px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', w * 0.36, h / 2);
      ctx.fillText('FC', w * 0.66, h / 2);
    },
    256,
    180,
  );
  const texL = markerTex('L', hex(COL.greyLabel), hex(COL.greyLabel));
  const texR = markerTex('R', hex(COL.red), hex(COL.red));

  /* ---- BODY ---- */
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'caseBody';
  caseGroup.add(bodyGroup);

  // ONE smooth full-height body shell with two real oval well through-holes.
  // Single extruded piece → continuous rounded exterior, no mid-height seam.
  const shell = piercedDeck(
    CASE_LEN,
    CASE_DEP,
    BODY_H,
    R,
    [
      { cx: -WELL_X, cy: 0, rx: WELL_RX, ry: WELL_RZ },
      { cx: WELL_X, cy: 0, rx: WELL_RX, ry: WELL_RZ },
    ],
    matBody,
    0.12,
    shadows,
  );
  bodyGroup.add(shell);

  // hidden solid interior plug: seals the bottom and forms the two well floors
  const plug = stadiumSlab(CASE_LEN - 0.06, CASE_DEP - 0.06, WELL_FLOOR_Y, R - 0.03, matBody, 0.06, shadows);
  bodyGroup.add(plug);

  // Well contents (pocket walls come from the pierced deck): dark floor + inner
  // stadium liner, a raised oval seat island, and a silver contact block with
  // 3 gold pogo pins at the outer end (như ảnh 14/15).
  function makeWell(sign: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(sign * WELL_X, 0, 0);
    const floorY = WELL_FLOOR_Y;

    // dark pocket floor
    const floorGeo = new THREE.CircleGeometry(1, 64);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.scale(WELL_RX * 0.96, 1, WELL_RZ * 0.96);
    const floor = new THREE.Mesh(floorGeo, matInner);
    floor.position.y = floorY + 0.004;
    floor.receiveShadow = shadows;
    g.add(floor);

    // raised oval seat island in the centre (where the earbud body nests)
    const islandGeo = new THREE.SphereGeometry(1, 44, 26, 0, Math.PI * 2, 0, Math.PI * 0.5);
    islandGeo.scale(WELL_RX * 0.58, 0.18, WELL_RZ * 0.6);
    const island = new THREE.Mesh(islandGeo, matInner);
    island.position.set(0, floorY + 0.006, 0.0);
    island.castShadow = shadows;
    g.add(island);

    // silver contact bracket seated deep against the outer pocket wall, tilted up-inward
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.16), matContactSilver);
    block.position.set(sign * 0.24, topY - 0.27, 0);
    block.rotation.z = sign * 0.42;
    block.castShadow = shadows;
    g.add(block);

    // 3 gold pogo pins on the inward-facing top of the bracket
    for (let i = 0; i < 3; i++) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.02, 12), matGold);
      pin.position.set(sign * 0.205, topY - 0.235, -0.05 + i * 0.05);
      pin.rotation.z = sign * 0.42;
      g.add(pin);
    }

    return g;
  }
  bodyGroup.add(makeWell(-1));
  bodyGroup.add(makeWell(1));

  const lMark = decal(texL, 0.16, 0.16);
  lMark.rotation.x = -Math.PI / 2;
  lMark.position.set(-0.14, topY + 0.005, -0.03);
  bodyGroup.add(lMark);
  const rMark = decal(texR, 0.16, 0.16);
  rMark.rotation.x = -Math.PI / 2;
  rMark.position.set(0.14, topY + 0.005, -0.03);
  bodyGroup.add(rMark);

  const nfc = decal(texNFC, 0.22, 0.15);
  nfc.rotation.x = -Math.PI / 2;
  nfc.position.set(0, topY + 0.005, 0.3);
  bodyGroup.add(nfc);
  const redStrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.012, 0.05), matRed);
  redStrip.position.set(0, topY + 0.002, 0.42);
  bodyGroup.add(redStrip);

  /* ---- LID (copper, rear hinge) ---- */
  const lidPivot = new THREE.Group();
  lidPivot.name = 'caseLidPivot';
  lidPivot.position.set(0, topY - 0.1, -CASE_DEP / 2 + 0.06);
  caseGroup.add(lidPivot);

  const lidGroup = new THREE.Group();
  lidPivot.add(lidGroup);

  // copper lid slightly larger than the body so its skirt overhangs and covers
  // the body's top edge with a crisp parting line (như ảnh 16)
  const lidOuter = stadiumSlab(CASE_LEN + 0.06, CASE_DEP + 0.06, LID_H, R + 0.03, matCopper, 0.12, shadows);
  lidOuter.position.set(0, 0.0, CASE_DEP / 2 - 0.06);
  lidGroup.add(lidOuter);

  const lidInner = stadiumSlab(CASE_LEN - 0.18, CASE_DEP - 0.18, 0.12, R - 0.09, matInner, 0.04, shadows);
  lidInner.position.set(0, -0.035, CASE_DEP / 2 - 0.06);
  lidGroup.add(lidInner);

  function lidBump(sign: number): void {
    const g = new THREE.SphereGeometry(0.3, 40, 28);
    g.scale(1.0, 0.2, 0.78);
    const m = new THREE.Mesh(g, matInner);
    m.position.set(sign * WELL_X, -0.03, CASE_DEP / 2 - 0.06);
    m.castShadow = shadows;
    lidGroup.add(m);
  }
  lidBump(-1);
  lidBump(1);

  const lidSony = decal(texLidSony, 0.86, 0.43);
  lidSony.rotation.x = -Math.PI / 2;
  lidSony.position.set(0, LID_H + 0.001, CASE_DEP / 2 - 0.06);
  (lidSony.material as THREE.MeshBasicMaterial).opacity = 0.9;
  lidGroup.add(lidSony);

  const specPlate = decal(texSpec, 1.3, 0.27);
  specPlate.rotation.x = Math.PI / 2;
  specPlate.rotation.z = Math.PI;
  specPlate.position.set(0, -0.041, CASE_DEP / 2 + 0.3);
  lidGroup.add(specPlate);

  const hingeGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.5, 20);
  hingeGeo.rotateZ(Math.PI / 2);
  for (const x of [-0.85, 0.85]) {
    const h = new THREE.Mesh(hingeGeo, matCopper);
    h.position.set(x, 0, 0);
    lidPivot.add(h);
  }

  /* ---- EARBUDS ---- */
  function makeEarbud(sign: number): THREE.Group {
    const bud = new THREE.Group();
    const core = new THREE.Group();
    bud.add(core);

    const shellGeo = new THREE.SphereGeometry(0.3, 48, 40);
    shellGeo.scale(1.14, 0.86, 0.74);
    const shell = new THREE.Mesh(shellGeo, matBud);
    shell.position.z = -0.05;
    shell.castShadow = shadows;
    core.add(shell);

    const faceGeo = new THREE.SphereGeometry(0.29, 56, 40, 0, Math.PI * 2, 0, Math.PI * 0.44);
    faceGeo.rotateX(Math.PI / 2);
    faceGeo.scale(1.04, 0.9, 0.42);
    const face = new THREE.Mesh(faceGeo, matBud);
    face.position.set(0, 0, 0.1);
    face.castShadow = shadows;
    core.add(face);

    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.275, 0.006, 10, 60), matInner);
    seam.scale.set(1.04, 0.9, 1);
    seam.position.set(0, 0, 0.11);
    core.add(seam);

    const sonyPlane = decal(texBudSony, 0.2, 0.08);
    sonyPlane.position.set(-0.03, 0, 0.205);
    core.add(sonyPlane);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.008, 12, 24), matCopper);
    ring.position.set(0.11, 0, 0.2);
    core.add(ring);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.014, 20), matInner);
    hole.position.set(0.11, 0, 0.206);
    core.add(hole);

    const nozzle = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.11, 0.18, 28), matBud);
    stem.position.y = -0.09;
    nozzle.add(stem);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 28, 20), matSilicone);
    tip.scale.set(1, 1.12, 1);
    tip.position.y = -0.22;
    tip.castShadow = shadows;
    nozzle.add(tip);
    const bore = new THREE.Mesh(
      new THREE.CircleGeometry(0.04, 20),
      new THREE.MeshBasicMaterial({ color: 0x050505 }),
    );
    bore.rotation.x = -Math.PI / 2;
    bore.position.y = -0.325;
    nozzle.add(bore);
    nozzle.position.set(0.03, -0.13, -0.06);
    nozzle.rotation.set(-0.55, 0, 0.16);
    core.add(nozzle);

    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.018, 16), matGold);
      p.rotation.x = Math.PI / 2;
      p.position.set(-0.05 + i * 0.05, -0.03, -0.285);
      core.add(p);
    }

    core.rotation.x = -0.95;
    core.rotation.y = sign > 0 ? 0.55 : -0.55;
    return bud;
  }

  const budL = makeEarbud(-1);
  const budR = makeEarbud(1);
  budL.name = 'leftEarbud';
  budR.name = 'rightEarbud';
  root.add(budL);
  root.add(budR);
  root.userData.exportModels = [
    { id: 'charging-case', label: 'Charging case', root: caseGroup },
    { id: 'left-earbud', label: 'Left earbud', root: budL },
    { id: 'right-earbud', label: 'Right earbud', root: budR },
  ];

  const seat = {
    L: { pos: new THREE.Vector3(-WELL_X, topY - 0.06, 0.02), rot: new THREE.Euler(0.15, 0, 0.05) },
    R: { pos: new THREE.Vector3(WELL_X, topY - 0.06, 0.02), rot: new THREE.Euler(0.15, 0, -0.05) },
  };

  /* ---- animation timeline ---- */
  const CYCLE = 11.0;
  const OPEN_ANGLE = -2.02;
  const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
  const smooth = (x: number, a: number, b: number): number =>
    easeInOut(THREE.MathUtils.clamp((x - a) / (b - a), 0, 1));
  const segAt = (x: number, a: number, b: number): number => THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);

  function placeBud(
    bud: THREE.Group,
    s: { pos: THREE.Vector3; rot: THREE.Euler },
    xSign: number,
    lift: number,
    spinTurn: number,
    bob: number,
  ): void {
    const upY = topY + 1.05 + bob;
    const outX = s.pos.x + xSign * 0.28 * lift;
    bud.position.set(
      THREE.MathUtils.lerp(s.pos.x, outX, lift),
      THREE.MathUtils.lerp(s.pos.y, upY, lift),
      THREE.MathUtils.lerp(s.pos.z, 0.02, lift),
    );
    bud.rotation.y = spinTurn * lift;
    bud.rotation.x = THREE.MathUtils.lerp(s.rot.x, -0.15, lift);
    bud.rotation.z = THREE.MathUtils.lerp(s.rot.z, 0, lift);
    bud.scale.setScalar(THREE.MathUtils.lerp(1, 1.02, lift));
  }

  function updateAnimation(time: number): void {
    const t = time % CYCLE;
    const openO = smooth(t, 0.4, 2.0);
    const riseO = smooth(t, 2.0, 3.4);
    const spinO = segAt(t, 3.4, 6.4);
    const fallO = smooth(t, 6.6, 8.0);
    const closeO = smooth(t, 8.4, 9.9);

    const lidOpen = openO * (1 - closeO);
    lidPivot.rotation.x = OPEN_ANGLE * lidOpen;

    const tiltAmt = Math.max(riseO * (1 - fallO), lidOpen * 0.25);
    root.rotation.z = -0.1 * tiltAmt;
    root.rotation.x = 0.06 * tiltAmt;
    root.rotation.y = Math.sin(time * 0.18) * 0.12;

    const lift = Math.max(riseO * (1 - fallO), 0);
    const spinTurn = easeOut(spinO) * Math.PI * 2;
    const bob = Math.sin(time * 2.2) * 0.03 * lift;

    placeBud(budL, seat.L, -1, lift, spinTurn, bob);
    placeBud(budR, seat.R, 1, lift, spinTurn, bob);
  }

  updateAnimation(0);
  root.userData.tick = (_dt: number, elapsed: number): void => updateAnimation(elapsed);

  return root;
}

/* ============================================================ */
/* lights + background                                          */
/* ============================================================ */
export function createSonyWf1000xm3LookDevLights(): THREE.Group {
  const lights = new THREE.Group();

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -6;
  kc.right = 6;
  kc.top = 6;
  kc.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 6;
  lights.add(key);

  const fill = new THREE.DirectionalLight(0xdfe6ff, 0.7);
  fill.position.set(-5, 3, 2);
  lights.add(fill);

  const fill2 = new THREE.DirectionalLight(0xffffff, 0.5);
  fill2.position.set(2, 2, 6);
  lights.add(fill2);

  const rim = new THREE.DirectionalLight(0xffe8cf, 0.65);
  rim.position.set(-3, 4, -6);
  lights.add(rim);

  lights.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9d, 0.4));
  return lights;
}

export function makeSonyBackground(): THREE.Color {
  return new THREE.Color(0xeceded);
}
