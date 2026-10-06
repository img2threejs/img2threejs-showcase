import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  group: THREE.Group;
};

const TEXTURE_BASE = '/img2threejs/assets/textures/';

function loadDopplerTexture(url: string, anisotropy = 8): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function physMat(color: number | string, opts: {
  metalness?: number; roughness?: number; iridescence?: number; clearcoat?: number;
  map?: THREE.Texture;
} = {}): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: opts.metalness ?? 0.5,
    roughness: opts.roughness ?? 0.4,
    iridescence: opts.iridescence ?? 0,
    iridescenceIOR: 1.3,
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: 0.1,
    map: opts.map,
  });
}

function buildFalchionBlade(dopplerMap: THREE.Texture): THREE.Mesh {
  // Falchion blade profile: spine on top (straight), curved edge that recurves
  // Length 5.05, height 2.5, in local X/Y
  const shape = new THREE.Shape();
  shape.moveTo(0, 2.5);              // spine root
  shape.lineTo(0.0, 1.0);            // ricasso flat
  shape.lineTo(0.5, 1.0);
  shape.lineTo(4.6, 0.7);            // spine runs nearly straight
  shape.lineTo(4.95, 0.5);
  shape.lineTo(5.05, 0.0);           // clip-point tip
  shape.quadraticCurveTo(4.5, -1.0, 3.0, -1.0);  // belly
  shape.quadraticCurveTo(1.5, -1.0, 0.0, -0.5);  // edge to ricasso
  shape.lineTo(0.0, 0.0);
  shape.lineTo(0.0, 1.0);
  shape.lineTo(0.0, 2.5);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelSegments: 4,
    bevelSize: 0.05,
    bevelThickness: 0.05,
    curveSegments: 24,
  });
  geo.translate(0, 0, -0.09);
  geo.computeVertexNormals();

  const mat = physMat(0x1b2d8a, {
    metalness: 1.0, roughness: 0.12, iridescence: 0.7, clearcoat: 0.5, map: dopplerMap
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function buildHandleScale(dopplerMap: THREE.Texture, mirror = false): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.8);
  shape.lineTo(2.7, 0.8);
  shape.lineTo(2.7, -0.6);
  shape.quadraticCurveTo(2.0, -1.0, 1.3, -0.6);
  shape.quadraticCurveTo(0.6, -0.2, 0.0, -0.6);
  shape.lineTo(0.0, 0.8);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.18, bevelEnabled: true, bevelSegments: 3,
    bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 16
  });
  geo.translate(0, 0, mirror ? 0.0 : -0.18);
  geo.computeVertexNormals();

  const mat = physMat(0x4a6fd4, {
    metalness: 0.4, roughness: 0.18, iridescence: 0.5, clearcoat: 0.7, map: dopplerMap
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function cylinderMesh(radius: number, height: number, color: number, opts: { metalness?: number; roughness?: number } = {}): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 24);
  const mat = physMat(color, { metalness: opts.metalness ?? 1.0, roughness: opts.roughness ?? 0.3 });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function createFalchionKnifeDopplerSapphireModel(_options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Falchion Knife | Doppler Sapphire";

  const dopplerMap = loadDopplerTexture(TEXTURE_BASE + 'doppler-blade.png', 16);

  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};

  function addNode(id: string, obj: THREE.Object3D, x: number, y: number, z: number) {
    obj.position.set(x, y, z);
    obj.name = id;
    root.add(obj);
    nodes[id] = obj;
    if (obj instanceof THREE.Mesh) meshes[id] = obj;
  }

  // Blade (extruded curved profile)
  const blade = buildFalchionBlade(dopplerMap);
  addNode("blade", blade, 1.10, 0, 0);

  // Cutting-edge bevel
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(4.5, 0.12, 0.08),
    physMat(0xc8d4f0, { metalness: 1.0, roughness: 0.05, clearcoat: 0.5 })
  );
  edge.castShadow = true; edge.receiveShadow = true;
  addNode("blade-edge-bevel", edge, 3.5, -1.0, 0.12);

  // Pivot / Bolster
  const bolster = new THREE.Mesh(
    new THREE.BoxGeometry(2.20, 2.50, 0.22),
    physMat(0x6a6e72, { metalness: 1.0, roughness: 0.45, clearcoat: 0.2 })
  );
  bolster.castShadow = true; bolster.receiveShadow = true;
  addNode("bolster", bolster, -0.01, 0, 0);

  // Polished pivot screw
  const screw = cylinderMesh(0.30, 0.20, 0xc0c0c0, { metalness: 1.0, roughness: 0.05 });
  addNode("pivot-screw", screw, 0.10, 0.20, 0.20);
  screw.rotation.x = Math.PI / 2;

  // Handle scales
  const handleTop = buildHandleScale(dopplerMap, false);
  addNode("handle-top", handleTop, -2.76, 0, 0.0);

  const handleBot = buildHandleScale(dopplerMap, true);
  addNode("handle-bottom", handleBot, -2.76, 0, 0.0);

  // Pommel
  const pommelBlock = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 2.5, 0.20),
    physMat(0x2a2c30, { metalness: 1.0, roughness: 0.35, clearcoat: 0.3 })
  );
  pommelBlock.castShadow = true; pommelBlock.receiveShadow = true;
  addNode("pommel-block", pommelBlock, -4.85, 0, 0);

  const pommelR = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 24, 16),
    physMat(0x2a2c30, { metalness: 1.0, roughness: 0.30, clearcoat: 0.4 })
  );
  pommelR.scale.set(0.5, 1.0, 1.0);
  pommelR.castShadow = true; pommelR.receiveShadow = true;
  addNode("pommel-round", pommelR, -5.50, 0, 0);

  // Pocket clip
  const clip = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 1.80, 0.08),
    physMat(0x0a0a0a, { metalness: 0.7, roughness: 0.50 })
  );
  clip.castShadow = true; clip.receiveShadow = true;
  addNode("pocket-clip", clip, 0.40, -1.30, 0.18);

  const clipTip = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.40, 0.10),
    physMat(0x141414, { metalness: 0.7, roughness: 0.50 })
  );
  clipTip.castShadow = true; clipTip.receiveShadow = true;
  addNode("pocket-clip-tip", clipTip, 0.50, -2.30, 0.28);

  // Clip screws
  const clipScrew1 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-1", clipScrew1, 0.15, -0.70, 0.20);
  clipScrew1.rotation.x = Math.PI / 2;
  const clipScrew2 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-2", clipScrew2, 0.90, -0.70, 0.20);
  clipScrew2.rotation.x = Math.PI / 2;

  // Handle mounting screws
  const screwPositions = [-3.7, -2.76, -1.85];
  screwPositions.forEach((sx, i) => {
    const s = cylinderMesh(0.07, 0.05, 0x6a6e72, { metalness: 1.0, roughness: 0.30 });
    s.rotation.x = Math.PI / 2;
    addNode(`handle-screw-${i + 1}`, s, sx, -0.95, 0.13);
  });

  const parts = Object.entries(meshes).map(([id, m]) => ({ id, name: id, mesh: m, type: 'mesh' }));
  root.userData.sculptRuntime = {
    parts, partCount: parts.length, clickable: true, explodable: true,
    config: { startExplode: 0, fullExplode: 0.12 },
    controllers: [], sockets: {}
  };
  root.userData.nodes = nodes;
  root.userData.meshes = meshes;
  return root;
}

export function createFalchionKnifeDopplerSapphireLookDevLights(
  _mode: 'neutral' | 'grazing' | 'reference' = 'reference',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Falchion Knife | Doppler Sapphire look-dev lights";
  const hemi = new THREE.HemisphereLight(0xfff0d6, 0x363b42, 0.85);
  lights.add(hemi);
  const key = new THREE.DirectionalLight(0xffcf8a, 2.6);
  key.position.set(-4.5, 7.5, 5.0);
  lights.add(key);
  const fill = new THREE.DirectionalLight(0x8aa0d0, 0.9);
  fill.position.set(5.0, 2.0, 3.0);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(0, -3, -4);
  lights.add(rim);
  const accent = new THREE.PointLight(0x6a8eff, 0.6, 12);
  accent.position.set(2, 0, 1.5);
  lights.add(accent);
  return lights;
}

export function createFalchionKnifeDopplerSapphireEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  return env.texture;
}

export function frameFalchionKnifeDopplerSapphireCamera(camera: THREE.PerspectiveCamera): void {
  camera.position.set(6.0, 3.0, 7.0);
  camera.fov = 38;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

export function createFalchionKnifeDopplerSapphirePresentationComposer() {
  return null;
}

export function configureFalchionKnifeDopplerSapphireRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createFalchionKnifeDopplerSapphireInspectControls() {
  return null;
}
