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

function loadAlbedo(url: string, anisotropy = 8): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function loadLinear(url: string, anisotropy = 8): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function physMat(color: number | string, opts: {
  metalness?: number; roughness?: number; iridescence?: number; clearcoat?: number;
  map?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture;
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
    normalMap: opts.normalMap,
    roughnessMap: opts.roughnessMap,
  });
}

function buildFalchionBlade(
  dopplerMap: THREE.Texture,
  _iriMap: THREE.Texture,
  aoMap: THREE.Texture,
  normalMap?: THREE.Texture,
  roughnessMap?: THREE.Texture,
): THREE.Mesh {
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
  // Copy UV1 to UV2 so aoMap/iridescenceMap (which default to UV2) can sample the texture
  geo.setAttribute('uv2', new THREE.Float32BufferAttribute(geo.attributes.uv.array, 2));

  const mat = physMat(0x1b2d8a, {
    metalness: 0.6, roughness: 0.30, iridescence: 0.3, clearcoat: 0.5,
    map: dopplerMap, normalMap, roughnessMap,
  });
  mat.aoMap = aoMap;
  mat.aoMapIntensity = 0.6;
  mat.iridescenceIOR = 1.3;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function buildHandleScale(
  dopplerMap: THREE.Texture,
  normalMap?: THREE.Texture,
  mirror = false,
): THREE.Mesh {
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
    metalness: 0.4, roughness: 0.18, iridescence: 0.5, clearcoat: 0.7,
    map: dopplerMap, normalMap,
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

  const dopplerMap = loadAlbedo(TEXTURE_BASE + 'doppler-blade.png', 16);
  const normalMap = loadLinear(TEXTURE_BASE + 'doppler-normal.png', 16);
  const roughnessMap = loadLinear(TEXTURE_BASE + 'doppler-roughness.png', 16);
  const iriMap = loadLinear(TEXTURE_BASE + 'doppler-iri.png', 16);
  const aoMap = loadLinear(TEXTURE_BASE + 'doppler-ao.png', 16);

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
  // Bolster spans x=-1.10 to +1.10, so blade root sits at +1.10
  const blade = buildFalchionBlade(dopplerMap, iriMap, aoMap, normalMap, roughnessMap);
  addNode("blade", blade, 1.10, 0, 0);

  // Cutting-edge bevel — follows the curved edge profile
  // Build a thin curved strip along the blade's bottom edge
  const edgePath = new THREE.CurvePath<THREE.Vector2>();
  edgePath.add(
    new THREE.QuadraticBezierCurve(new THREE.Vector2(0.0, -0.5), new THREE.Vector2(1.5, -1.0), new THREE.Vector2(3.0, -1.0))
  );
  edgePath.add(
    new THREE.QuadraticBezierCurve(new THREE.Vector2(3.0, -1.0), new THREE.Vector2(4.5, -1.0), new THREE.Vector2(5.05, 0.0))
  );
  const edgeProfile = new THREE.ExtrudeGeometry(
    (() => {
      // Build a 2D shape: 0.10 tall strip following the curve, extruded thin
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      for (let t = 0; t <= 1; t += 0.02) {
        const p = edgePath.getPoint(t);
        s.lineTo(p.x, p.y);
      }
      for (let t = 1; t >= 0; t -= 0.02) {
        const p = edgePath.getPoint(t);
        s.lineTo(p.x, p.y + 0.12);
      }
      s.closePath();
      return s;
    })(),
    { depth: 0.06, bevelEnabled: false, curveSegments: 24 }
  );
  edgeProfile.translate(0, 0, -0.03);
  const edge = new THREE.Mesh(edgeProfile, physMat(0xc8d4f0, {
    metalness: 1.0, roughness: 0.05, clearcoat: 0.5
  }));
  edge.castShadow = true; edge.receiveShadow = true;
  addNode("blade-edge-bevel", edge, 1.10, 0, 0.10);

  // Pivot / Bolster — overlap the handle by 0.05, blade by 0.05
  const bolster = new THREE.Mesh(
    new THREE.BoxGeometry(2.30, 2.50, 0.22),
    physMat(0x6a6e72, { metalness: 1.0, roughness: 0.45, clearcoat: 0.2 })
  );
  bolster.castShadow = true; bolster.receiveShadow = true;
  addNode("bolster", bolster, -0.01, 0, 0);

  // Polished pivot screw — sits on the bolster, top-front
  const screw = cylinderMesh(0.30, 0.20, 0xc0c0c0, { metalness: 1.0, roughness: 0.05 });
  addNode("pivot-screw", screw, 0.10, 0.20, 0.18);
  screw.rotation.x = Math.PI / 2;

  // Handle scales — slightly overlap bolster on right side
  const handleTop = buildHandleScale(dopplerMap, normalMap, false);
  addNode("handle-top", handleTop, -2.85, 0, 0.05);

  const handleBot = buildHandleScale(dopplerMap, normalMap, true);
  addNode("handle-bottom", handleBot, -2.85, 0, 0.05);

  // Pommel — overlaps handle on right side
  const pommelBlock = new THREE.Mesh(
    new THREE.BoxGeometry(1.20, 2.5, 0.20),
    physMat(0x2a2c30, { metalness: 1.0, roughness: 0.35, clearcoat: 0.3 })
  );
  pommelBlock.castShadow = true; pommelBlock.receiveShadow = true;
  addNode("pommel-block", pommelBlock, -4.95, 0, 0);

  const pommelR = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 24, 16),
    physMat(0x2a2c30, { metalness: 1.0, roughness: 0.30, clearcoat: 0.4 })
  );
  pommelR.scale.set(0.5, 1.0, 1.0);
  pommelR.castShadow = true; pommelR.receiveShadow = true;
  addNode("pommel-round", pommelR, -5.60, 0, 0);

  // Pocket clip — curved via TubeGeometry along a path
  const clipCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.4,  0.55, 0.13),
    new THREE.Vector3(0.4,  0.0,  0.15),
    new THREE.Vector3(0.4, -0.6,  0.18),
    new THREE.Vector3(0.4, -1.2,  0.20),
    new THREE.Vector3(0.4, -1.7,  0.22),
    new THREE.Vector3(0.3, -1.95, 0.30),   // bent tip starts
    new THREE.Vector3(0.2, -2.10, 0.40),   // tip flares out
  ]);
  const clipTube = new THREE.TubeGeometry(clipCurve, 32, 0.08, 8, false);
  const clip = new THREE.Mesh(clipTube, physMat(0x0a0a0a, { metalness: 0.7, roughness: 0.50 }));
  clip.castShadow = true; clip.receiveShadow = true;
  addNode("pocket-clip", clip, 0, 0, 0);

  // Clip screws
  const clipScrew1 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-1", clipScrew1, 0.15, -0.70, 0.20);
  clipScrew1.rotation.x = Math.PI / 2;
  const clipScrew2 = cylinderMesh(0.08, 0.05, 0x0a0a0a, { metalness: 0.7, roughness: 0.40 });
  addNode("clip-screw-2", clipScrew2, 0.90, -0.70, 0.20);
  clipScrew2.rotation.x = Math.PI / 2;

  // Handle mounting screws — moved inside the handle body
  const screwPositions = [-3.95, -2.85, -1.75];
  screwPositions.forEach((sx, i) => {
    const s = cylinderMesh(0.07, 0.05, 0x6a6e72, { metalness: 1.0, roughness: 0.30 });
    s.rotation.x = Math.PI / 2;
    addNode(`handle-screw-${i + 1}`, s, sx, -1.05, 0.12);
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
