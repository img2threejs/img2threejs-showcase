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

/**
 * ★ Falchion Knife | Doppler Sapphire (Factory New)
 *
 * Layout (knife lies along +X, pommel at -X end, blade tip at +X end):
 *   pommel:        x = -5.23, length 2.25
 *   handle-rear:   x = -2.76, length 2.70
 *   pivot-bolster: x = -0.01, length 2.20
 *   blade:         x = +3.62, length 5.05, tip at +6.14
 */

function blockMesh(length: number, height: number, depth: number, color: number | string, opts: { metalness?: number; roughness?: number; iridescence?: number; clearcoat?: number } = {}): THREE.Mesh {
  const geo = new THREE.BoxGeometry(length, height, depth, 1, 1, 1);
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: opts.metalness ?? 0.5,
    roughness: opts.roughness ?? 0.4,
    iridescence: opts.iridescence ?? 0,
    iridescenceIOR: 1.3,
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: 0.1,
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cylinderMesh(radius: number, height: number, color: number, opts: { metalness?: number; roughness?: number } = {}): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 24);
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: opts.metalness ?? 1.0,
    roughness: opts.roughness ?? 0.3,
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function createFalchionKnifeDopplerSapphireModel(_options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Falchion Knife | Doppler Sapphire";

  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};

  function addNode(id: string, obj: THREE.Object3D, x: number, y: number, z: number) {
    obj.position.set(x, y, z);
    obj.name = id;
    root.add(obj);
    nodes[id] = obj;
    if (obj instanceof THREE.Mesh) meshes[id] = obj;
  }

  // Blade (Doppler Sapphire marble — deep blue with iridescence)
  const blade = blockMesh(5.05, 2.50, 0.18, 0x1b2d8a, { metalness: 1.0, roughness: 0.10, iridescence: 0.7, clearcoat: 0.4 });
  addNode("blade", blade, 3.62, 0, 0);
  blade.rotation.z = 0.04;

  // Blade tip (cone wedge)
  const bladeTip = new THREE.Mesh(
    new THREE.ConeGeometry(0.10, 1.2, 8),
    new THREE.MeshPhysicalMaterial({ color: 0x1b2d8a, metalness: 1.0, roughness: 0.08, iridescence: 0.8, clearcoat: 0.5 })
  );
  bladeTip.rotation.z = -Math.PI / 2;
  addNode("blade-tip", bladeTip, 6.14, 0, 0);

  // Cutting edge bevel
  const edge = blockMesh(5.0, 0.18, 0.10, 0xb4c0e8, { metalness: 1.0, roughness: 0.06, clearcoat: 0.3 });
  addNode("blade-edge-bevel", edge, 3.62, -1.16, 0.04);

  // Pivot / Bolster (gunmetal)
  const bolster = blockMesh(2.20, 2.50, 0.22, 0x6a6e72, { metalness: 1.0, roughness: 0.45, clearcoat: 0.2 });
  addNode("bolster", bolster, -0.01, 0, 0);

  // Pivot screw (polished steel)
  const screw = cylinderMesh(0.35, 0.30, 0xc0c0c0, { metalness: 1.0, roughness: 0.05 });
  addNode("pivot-screw", screw, 0.40, 0.85, 0.20);
  screw.rotation.x = Math.PI / 2;

  // Handle (Doppler Sapphire resin scales)
  const handle = blockMesh(2.70, 2.40, 0.20, 0x4a6fd4, { metalness: 0.4, roughness: 0.20, iridescence: 0.5, clearcoat: 0.6 });
  addNode("handle", handle, -2.76, 0, 0);

  // Handle thumb-rest
  const thumbRest = blockMesh(1.8, 0.10, 0.20, 0x6a85e6, { metalness: 0.5, roughness: 0.15 });
  addNode("handle-thumb-rest", thumbRest, -2.76, 1.20, 0);

  // Pommel (rounded steel butt cap)
  const pommel = blockMesh(2.25, 2.50, 0.20, 0x2a2c30, { metalness: 1.0, roughness: 0.35, clearcoat: 0.3 });
  addNode("pommel", pommel, -5.23, 0, 0);
  const pommelR = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 16, 12),
    new THREE.MeshPhysicalMaterial({ color: 0x2a2c30, metalness: 1.0, roughness: 0.30, clearcoat: 0.4 })
  );
  pommelR.scale.set(0.2, 1.0, 1.0);
  addNode("pommel-round", pommelR, -6.36, 0, 0);

  // Pocket clip (blackened steel)
  const clip = blockMesh(0.18, 1.80, 0.10, 0x0a0a0a, { metalness: 0.7, roughness: 0.50 });
  addNode("pocket-clip", clip, 0.20, -1.30, 0.20);
  const clipTip = blockMesh(0.10, 0.40, 0.10, 0x141414, { metalness: 0.7, roughness: 0.50 });
  addNode("pocket-clip-tip", clipTip, 0.20, -2.30, 0.30);

  // Clip screws
  const clipScrew1 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-1", clipScrew1, 0.15, -0.70, 0.20);
  clipScrew1.rotation.x = Math.PI / 2;
  const clipScrew2 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-2", clipScrew2, 0.90, -0.70, 0.20);
  clipScrew2.rotation.x = Math.PI / 2;

  // Handle mounting screws
  const screwPositions = [-3.8, -2.76, -1.7];
  screwPositions.forEach((sx, i) => {
    const s = cylinderMesh(0.07, 0.05, 0x6a6e72, { metalness: 1.0, roughness: 0.30 });
    s.rotation.x = Math.PI / 2;
    addNode(`handle-screw-${i+1}`, s, sx, -1.10, 0.13);
  });

  const parts = Object.entries(meshes).map(([id, m]) => ({ id, name: id, mesh: m, type: 'mesh' }));
  root.userData.sculptRuntime = {
    parts, partCount: parts.length, clickable: true, explodable: true,
    config: { startExplode: 0, fullExplode: 0.15 },
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
  const hemi = new THREE.HemisphereLight(0xfff0d6, 0x363b42, 0.72);
  lights.add(hemi);
  const key = new THREE.DirectionalLight(0xffcf8a, 2.6);
  key.position.set(-4.5, 7.5, 5.0);
  lights.add(key);
  const fill = new THREE.DirectionalLight(0x8aa0d0, 0.8);
  fill.position.set(5.0, 2.0, 3.0);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(0, -3, -4);
  lights.add(rim);
  return lights;
}

export function createFalchionKnifeDopplerSapphireEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  return env.texture;
}

export function frameFalchionKnifeDopplerSapphireCamera(camera: THREE.PerspectiveCamera): void {
  camera.position.set(8.0, 3.5, 9.0);
  camera.fov = 32;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

export function createFalchionKnifeDopplerSapphirePresentationComposer() {
  return null;
}

export function configureFalchionKnifeDopplerSapphireRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createFalchionKnifeDopplerSapphireInspectControls() {
  return null;
}
