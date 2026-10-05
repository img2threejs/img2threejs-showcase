import * as THREE from 'three';

/**
 * ★ Falchion Knife | Doppler Sapphire (Factory New)
 *
 * Hand-written procedural reconstruction from a single CS:GO inventory screenshot.
 * Faithful to the reference's identity-defining features:
 *  - Clip-point recurve blade, solid (no ring) pommel, gunmetal pivot housing,
 *    finger-choil on the handle underside, marbled blue/violet Doppler pattern
 *    (Sapphire phase 1) on the blade belly AND the handle scales, blackened-steel
 *    rear pocket clip with bent tip.
 *  - 3-point studio lighting + HDRI envmap for the iridescent thin-film response.
 *
 * Exports:
 *  - createFalchionSapphireModel({...}) -> THREE.Group
 *  - createFalchionSapphireLookDevLights() -> THREE.Group
 *  - frameFalchionSapphireCamera(camera, object, options?) -> void
 *  - makeStudioBackground() -> THREE.CanvasTexture
 */

export type FalchionSapphireOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  wireframe?: boolean;
  textureSize?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

const DEFAULTS = {
  castShadow: true,
  receiveShadow: true,
  wireframe: false,
  textureSize: 1024,
  qualityPriority: 'reference-fidelity' as const,
};

/* =========================================================================
 * Materials
 * ========================================================================= */

function makeDopplerSapphireMaterial(opts: { iridescence?: number; clearcoat?: number; textureSize: number; }): THREE.MeshPhysicalMaterial {
  // Procedural canvas: marbled blue/violet Doppler Sapphire pattern
  const S = opts.textureSize;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  // Base deep blue
  const baseGrad = ctx.createLinearGradient(0, 0, S, S);
  baseGrad.addColorStop(0, '#0a1645');
  baseGrad.addColorStop(0.5, '#1a2a55');
  baseGrad.addColorStop(1, '#0a1645');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, S, S);
  // Marbled veins (dark)
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(${10 + Math.random() * 10}, ${15 + Math.random() * 10}, ${50 + Math.random() * 15}, ${0.4 + Math.random() * 0.3})`;
    ctx.lineWidth = 1 + Math.random() * 4;
    ctx.beginPath();
    const x0 = Math.random() * S;
    const y0 = Math.random() * S;
    ctx.moveTo(x0, y0);
    for (let j = 0; j < 6; j++) {
      const cx = x0 + (Math.random() - 0.5) * S * 0.5;
      const cy = y0 + (Math.random() - 0.5) * S * 0.5;
      const x = x0 + (Math.random() - 0.5) * S;
      const y = y0 + (Math.random() - 0.5) * S;
      ctx.quadraticCurveTo(cx, cy, x, y);
    }
    ctx.stroke();
  }
  // Bright highlights (lighter)
  for (let i = 0; i < 8; i++) {
    const cx = Math.random() * S;
    const cy = Math.random() * S;
    const r = 30 + Math.random() * 100;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(140, 170, 255, ${0.2 + Math.random() * 0.15})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;

  return new THREE.MeshPhysicalMaterial({
    map: tex,
    metalness: 0.85,
    roughness: 0.18,
    iridescence: opts.iridescence ?? 0.85,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [180, 540],
    clearcoat: opts.clearcoat ?? 0.5,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.4,
  });
}

function makeHandleResinMaterial(textureSize: number): THREE.MeshPhysicalMaterial {
  // Translucent purple/violet marbled resin
  const S = textureSize;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const baseGrad = ctx.createLinearGradient(0, 0, S, S);
  baseGrad.addColorStop(0, '#2a1a55');
  baseGrad.addColorStop(0.5, '#3a2a55');
  baseGrad.addColorStop(1, '#2a1a55');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, S, S);
  // Marbled resin veins
  for (let i = 0; i < 10; i++) {
    ctx.strokeStyle = `rgba(${100 + Math.random() * 50}, ${50 + Math.random() * 30}, ${150 + Math.random() * 50}, ${0.3 + Math.random() * 0.3})`;
    ctx.lineWidth = 2 + Math.random() * 5;
    ctx.beginPath();
    const x0 = Math.random() * S;
    const y0 = Math.random() * S;
    ctx.moveTo(x0, y0);
    for (let j = 0; j < 4; j++) {
      const x = x0 + (Math.random() - 0.5) * S * 0.6;
      const y = y0 + (Math.random() - 0.5) * S * 0.6;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshPhysicalMaterial({
    map: tex,
    metalness: 0.0,
    roughness: 0.32,
    transmission: 0.45,
    thickness: 0.6,
    ior: 1.45,
    color: '#3a2a55',
    attenuationColor: '#2a1a55',
    attenuationDistance: 0.4,
    clearcoat: 0.6,
    clearcoatRoughness: 0.1,
  });
}

function makeGunmetalMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: '#4a4a4a',
    metalness: 0.88,
    roughness: 0.42,
  });
}

function makeBlackenedSteelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: '#1a1a1a',
    metalness: 0.7,
    roughness: 0.35,
  });
}

/* =========================================================================
 * Geometry builders
 * ========================================================================= */

function buildBladeShape(): THREE.Shape {
  // Clip-point recurve silhouette: tip pointing right, recurve belly below
  const s = new THREE.Shape();
  s.moveTo(0, 0.0);
  s.lineTo(0, 0.18);
  s.lineTo(0.55, 0.22);
  s.lineTo(0.88, 0.18);
  s.lineTo(1.0, 0.05);
  s.lineTo(0.96, -0.04);
  s.quadraticCurveTo(0.55, -0.15, 0.0, -0.05);
  s.lineTo(0, 0.0);
  return s;
}

function buildHandleShape(): THREE.Shape {
  // Ergonomic handle scale (one side)
  const s = new THREE.Shape();
  s.moveTo(0, 0.0);
  s.lineTo(-0.05, 0.12);
  s.lineTo(-0.32, 0.16);
  s.lineTo(-0.55, 0.13);
  s.quadraticCurveTo(-0.68, 0.08, -0.65, 0.0);
  s.quadraticCurveTo(-0.68, -0.08, -0.55, -0.10);
  s.lineTo(-0.32, -0.12);
  s.quadraticCurveTo(-0.15, -0.08, -0.05, -0.05);
  s.lineTo(0, 0.0);
  return s;
}

function buildBolsterShape(): THREE.Shape {
  // Pivot housing — small chamfered block
  const s = new THREE.Shape();
  const w = 0.16, h = 0.28;
  s.moveTo(-w/2, -h/2);
  s.lineTo(w/2, -h/2);
  s.lineTo(w/2, h/2);
  s.lineTo(-w/2, h/2);
  s.closePath();
  return s;
}

function buildPocketClipShape(): THREE.Shape {
  // Thin sheet metal with bent tip
  const s = new THREE.Shape();
  s.moveTo(0, 0.0);
  s.lineTo(-0.5, 0.0);
  s.lineTo(-0.52, 0.04);
  s.lineTo(-0.5, 0.08);
  s.lineTo(-0.05, 0.08);
  s.quadraticCurveTo(0, 0.05, 0.0, 0.0);
  s.closePath();
  return s;
}

function buildPommelShape(): THREE.Shape {
  // Solid rounded pommel
  const s = new THREE.Shape();
  s.moveTo(-0.65, 0.0);
  s.absarc(-0.65, 0.0, 0.10, 0, Math.PI * 2, false);
  s.closePath();
  return s;
}

/* =========================================================================
 * Main model
 * ========================================================================= */

export function createFalchionSapphireModel(options: FalchionSapphireOptions = {}): THREE.Group {
  const o = { ...DEFAULTS, ...options };
  const root = new THREE.Group();
  root.name = 'Falchion Sapphire';

  const textureSize = o.textureSize;
  const bladeMat = makeDopplerSapphireMaterial({ iridescence: 0.85, clearcoat: 0.5, textureSize });
  const handleMat = makeHandleResinMaterial(textureSize);
  const gunmetalMat = makeGunmetalMaterial();
  const blackenedMat = makeBlackenedSteelMaterial();
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#3a5a85', metalness: 0.9, roughness: 0.18 });

  // === Blade ===
  const bladeShape = buildBladeShape();
  const bladeGeom = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 4,
    steps: 1,
  });
  bladeGeom.center();
  const blade = new THREE.Mesh(bladeGeom, bladeMat);
  blade.name = 'blade';
  blade.castShadow = o.castShadow;
  blade.receiveShadow = o.receiveShadow;
  blade.position.set(0.55, 0.0, 0.0);
  blade.rotation.y = Math.PI / 2;
  root.add(blade);

  // === Handle (two mirrored scales) ===
  const handleShape = buildHandleShape();
  const handleGeom = new THREE.ExtrudeGeometry(handleShape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 3,
    steps: 1,
  });
  handleGeom.center();
  const handleTop = new THREE.Mesh(handleGeom, handleMat);
  handleTop.name = 'handle-top';
  handleTop.castShadow = o.castShadow;
  handleTop.receiveShadow = o.receiveShadow;
  handleTop.position.set(-0.32, 0.0, 0.05);
  root.add(handleTop);

  const handleBottom = new THREE.Mesh(handleGeom, handleMat);
  handleBottom.name = 'handle-bottom';
  handleBottom.castShadow = o.castShadow;
  handleBottom.receiveShadow = o.receiveShadow;
  handleBottom.position.set(-0.32, 0.0, -0.05);
  handleBottom.scale.z = -1;
  root.add(handleBottom);

  // === Bolster (pivot housing) ===
  const bolsterGeom = new THREE.ExtrudeGeometry(buildBolsterShape(), {
    depth: 0.10,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
    steps: 1,
  });
  bolsterGeom.center();
  const bolster = new THREE.Mesh(bolsterGeom, gunmetalMat);
  bolster.name = 'bolster';
  bolster.castShadow = o.castShadow;
  bolster.receiveShadow = o.receiveShadow;
  bolster.position.set(0.04, 0.0, 0.0);
  root.add(bolster);

  // === Pivot screw ===
  const screwGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 24);
  const screw = new THREE.Mesh(screwGeom, gunmetalMat);
  screw.name = 'pivot-screw';
  screw.castShadow = o.castShadow;
  screw.receiveShadow = o.receiveShadow;
  screw.rotation.x = Math.PI / 2;
  screw.position.set(0.04, 0.0, 0.0);
  root.add(screw);

  // Cap with concentric rings
  const capGeom = new THREE.CylinderGeometry(0.05, 0.045, 0.012, 24);
  const capTop = new THREE.Mesh(capGeom, gunmetalMat);
  capTop.name = 'pivot-cap-top';
  capTop.position.set(0.04, 0.0, 0.06);
  capTop.rotation.x = Math.PI / 2;
  root.add(capTop);
  const capBot = new THREE.Mesh(capGeom, gunmetalMat);
  capBot.name = 'pivot-cap-bottom';
  capBot.position.set(0.04, 0.0, -0.06);
  capBot.rotation.x = Math.PI / 2;
  root.add(capBot);

  // === Mounting screws on handle (4 small) ===
  const mountScrewGeom = new THREE.CylinderGeometry(0.018, 0.018, 0.10, 16);
  for (let i = 0; i < 4; i++) {
    const x = -0.12 - i * 0.12;
    const mTop = new THREE.Mesh(mountScrewGeom, gunmetalMat);
    mTop.name = `mounting-screw-${i + 1}-top`;
    mTop.position.set(x, 0.0, 0.07);
    mTop.rotation.x = Math.PI / 2;
    mTop.castShadow = o.castShadow;
    root.add(mTop);
    const mBot = new THREE.Mesh(mountScrewGeom, gunmetalMat);
    mBot.name = `mounting-screw-${i + 1}-bottom`;
    mBot.position.set(x, 0.0, -0.07);
    mBot.rotation.x = Math.PI / 2;
    mBot.castShadow = o.castShadow;
    root.add(mBot);
  }

  // === Pommel (solid rounded, no ring) ===
  const pommelGeom = new THREE.ExtrudeGeometry(buildPommelShape(), {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 4,
    steps: 1,
  });
  pommelGeom.center();
  const pommel = new THREE.Mesh(pommelGeom, handleMat);
  pommel.name = 'pommel';
  pommel.castShadow = o.castShadow;
  pommel.receiveShadow = o.receiveShadow;
  pommel.position.set(-0.62, 0.0, 0.0);
  root.add(pommel);

  // === Pocket clip (blackened steel, rear-mounted) ===
  const clipGeom = new THREE.ExtrudeGeometry(buildPocketClipShape(), {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.002,
    bevelSize: 0.002,
    bevelSegments: 2,
    steps: 1,
  });
  clipGeom.center();
  const clip = new THREE.Mesh(clipGeom, blackenedMat);
  clip.name = 'pocket-clip';
  clip.castShadow = o.castShadow;
  clip.receiveShadow = o.receiveShadow;
  clip.position.set(-0.35, 0.0, 0.10);
  clip.rotation.x = Math.PI / 2;
  root.add(clip);

  // Clip mounting screws (2)
  const clipScrewGeom = new THREE.CylinderGeometry(0.012, 0.012, 0.014, 12);
  for (let i = 0; i < 2; i++) {
    const x = -0.18 - i * 0.30;
    const c = new THREE.Mesh(clipScrewGeom, blackenedMat);
    c.name = `clip-screw-${i + 1}`;
    c.position.set(x, 0.0, 0.10);
    c.rotation.x = Math.PI / 2;
    c.castShadow = o.castShadow;
    root.add(c);
  }

  // === Edge bevel (thin bright strip along the cutting edge) ===
  const edgeShape = new THREE.Shape();
  edgeShape.moveTo(0.05, -0.07);
  edgeShape.lineTo(0.95, -0.04);
  edgeShape.lineTo(0.93, -0.06);
  edgeShape.quadraticCurveTo(0.55, -0.13, 0.05, -0.09);
  edgeShape.closePath();
  const edgeGeom = new THREE.ExtrudeGeometry(edgeShape, {
    depth: 0.06,
    bevelEnabled: false,
    steps: 1,
  });
  edgeGeom.center();
  const edge = new THREE.Mesh(edgeGeom, edgeMat);
  edge.name = 'blade-edge';
  edge.position.set(0.55, 0.0, 0.0);
  edge.rotation.y = Math.PI / 2;
  root.add(edge);

  // === Finger choil cut (visible scoop on handle underside) ===
  const choilGeom = new THREE.BoxGeometry(0.10, 0.04, 0.06);
  const choil = new THREE.Mesh(choilGeom, new THREE.MeshStandardMaterial({ color: '#1a1a2a', roughness: 0.5, metalness: 0.4 }));
  choil.name = 'finger-choil';
  choil.position.set(-0.08, -0.10, 0.0);
  root.add(choil);

  // === Idle float spin animation ===
  root.userData.tick = (_dt: number, elapsed: number) => {
    root.rotation.y = Math.sin(elapsed * 0.4) * 0.08;
    root.position.y = Math.sin(elapsed * 1.2) * 0.005;
  };

  // === sculptRuntime: explodable/clickable hierarchy ===
  const parts: Array<{ name: string; mesh: THREE.Mesh; parentSocket?: string; pivots?: string[] }> = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name) {
      parts.push({ name: obj.name, mesh: obj });
    }
  });
  root.userData.sculptRuntime = {
    parts,
    partCount: parts.length,
    clickable: true,
    explodable: true,
    config: { startExplode: 0, fullExplode: 0.1 },
    controllers: [],
    sockets: {
      'blade.root': { parent: 'bolster', position: [0, 0, 0] },
      'handle-top.front': { parent: 'handle-top', position: [0, 0, 0.05] },
      'handle-bottom.back': { parent: 'handle-bottom', position: [0, 0, -0.05] },
      'pivot-screw.center': { parent: 'bolster', position: [0.04, 0, 0] },
      'pocket-clip.rear': { parent: 'handle-bottom', position: [-0.35, 0, -0.10] },
      'pommel.rear': { parent: 'handle-top', position: [-0.62, 0, 0] },
    },
  };

  return root;
}

/* =========================================================================
 * Lighting
 * ========================================================================= */

export function createFalchionSapphireLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'falchion-sapphire-lights';

  // Key light (warm, upper-right)
  const key = new THREE.DirectionalLight('#fff5e6', 1.5);
  key.position.set(3, 4, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -2;
  key.shadow.camera.right = 2;
  key.shadow.camera.top = 2;
  key.shadow.camera.bottom = -2;
  key.shadow.bias = -0.0002;
  lights.add(key);

  // Fill light (cool, left)
  const fill = new THREE.DirectionalLight('#cce0ff', 0.6);
  fill.position.set(-3, 2, 3);
  lights.add(fill);

  // Rim light (cool, back)
  const rim = new THREE.DirectionalLight('#a0c4ff', 0.9);
  rim.position.set(0, 2, -5);
  lights.add(rim);

  // Ambient
  const ambient = new THREE.AmbientLight('#3a4a6a', 0.25);
  lights.add(ambient);

  // Environment hemisphere
  const env = new THREE.HemisphereLight('#a0c4ff', '#1a1a2a', 0.4);
  lights.add(env);

  return lights;
}

/* =========================================================================
 * Camera framing
 * ========================================================================= */

export function frameFalchionSapphireCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {}
): void {
  const margin = options.margin ?? 1.15;
  const azimuthDeg = options.azimuthDeg ?? 0;
  const elevationDeg = options.elevationDeg ?? 0;
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * margin;
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const x = center.x + radius * Math.cos(el) * Math.sin(az);
  const y = center.y + radius * Math.sin(el);
  const z = center.z + radius * Math.cos(el) * Math.cos(az);
  camera.position.set(x, y, z);
  camera.lookAt(center);
  if (camera.isPerspectiveCamera) {
    const fov = camera.fov;
    const distance = camera.position.distanceTo(center);
    const halfHeight = Math.tan((fov * Math.PI) / 360) * distance;
    camera.zoom = (halfHeight * 2) / (size.y * margin);
    if (camera.zoom < 0.1) camera.zoom = 1;
    camera.updateProjectionMatrix();
  }
}

/* =========================================================================
 * Studio background
 * ========================================================================= */

export function makeStudioBackground(): THREE.CanvasTexture {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S * 0.5, S * 0.5, S * 0.05, S * 0.5, S * 0.5, S * 0.7);
  g.addColorStop(0, '#f6f7fa');
  g.addColorStop(0.5, '#e3e6ec');
  g.addColorStop(1, '#bfc4cc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
