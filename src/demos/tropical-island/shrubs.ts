import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface ShrubsResult {
  readonly group: THREE.Group;
  /** Advance vertex-shader wind. No allocations. */
  tick(elapsed: number, reducedMotion: boolean, daylight?: number): void;
  /** Idempotent. Disposes per-cluster shadow materials; visible geometry disposal is the Viewer's job. */
  dispose(): void;
}

/** Scene-XZ wind direction; matches the campfire/palm convention. */
const WIND_X = 0.92;
const WIND_Z = 0.39;

interface ClusterSpec {
  yaw: number;
  scale: number;
  seed: number;
  phase: number;
}

interface BuiltCluster {
  group: THREE.Group;
  /** Per-cluster uniforms shared by the visible + shadow materials; mutated by tick(). */
  uniforms: {
    uTime: { value: number };
    /** Wind in cluster-local XZ: scene wind counter-rotated by -spec.yaw, divided by scale. */
    uWind: { value: THREE.Vector2 };
    uPhase: { value: number };
    uDaylight: { value: number };
    uTint: { value: THREE.Color };
  };
  shadows: { depth: THREE.Material; distance: THREE.Material };
}

const LEAF_SEGMENTS = 9;
// Low, narrow rosettes rather than broad cupped leaves.
const LEAF_LENGTH = 0.40;
const STEM_RINGS = 6;
const STEM_RING_SIDES = 5;
// Petiole root radius — slimmer than the leaf half-width so the stem doesn't
// read as a thicker base than the leaf it supports.
const STEM_RADIUS = 0.009;

/** Tapered blade with a shallow crease and trailing-edge droop. */
function leafProfile(t: number): { width: number; arch: number; rib: number; droop: number } {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  const width = Math.sin(tt * Math.PI) * 0.045;
  const arch = Math.sin(tt * Math.PI) * 0.025;
  const rib = Math.sin(tt * Math.PI) * 0.010;
  const droop = tt > 0.5 ? -(tt - 0.5) * 0.018 : 0;
  return { width, arch, rib, droop };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lanceolate leaf ribbon. Three vertices per cross-section; all three share `z=arch` so the
 * base and tip are single points (matching the petiole/ribbon endpoint). The central rib
 * vertex sits at z=arch+rib — slightly in front of the wings, giving a subtle banana-petal
 * cross-section.
 */
function buildLeafGeometry(): THREE.BufferGeometry {
  const profileRows = LEAF_SEGMENTS + 1;
  const vertsPerRow = 3;
  const vertCount = profileRows * vertsPerRow;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  for (let r = 0; r < profileRows; r += 1) {
    const t = r / (profileRows - 1);
    const { width, arch, rib, droop } = leafProfile(t);
    const y = t * LEAF_LENGTH;
    const i = r * vertsPerRow;
    positions[i * 3] = -width;
    positions[i * 3 + 1] = y + droop;
    positions[i * 3 + 2] = arch;
    positions[i * 3 + 3] = 0;
    positions[i * 3 + 4] = y;
    positions[i * 3 + 5] = arch + rib;
    positions[i * 3 + 6] = width;
    positions[i * 3 + 7] = y + droop;
    positions[i * 3 + 8] = arch;
    uvs[i * 2] = 0;
    uvs[i * 2 + 1] = t;
    uvs[(i + 1) * 2] = 0.5;
    uvs[(i + 1) * 2 + 1] = t;
    uvs[(i + 2) * 2] = 1;
    uvs[(i + 2) * 2 + 1] = t;
  }
  const indices: number[] = [];
  for (let r = 0; r < profileRows - 1; r += 1) {
    const a = r * vertsPerRow;
    const b = (r + 1) * vertsPerRow;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
    indices.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Curved petiole as a tube. Cross-sections are perpendicular to the 3D centerline
 * tangent (the basis is recomputed per ring using a stable reference vector). Centerline:
 * r(t) = (sin(arc·t)·L, (1 - cos(arc·t))·L·0.55, 0).
 */
function buildStemGeometry(arc: number, length: number): THREE.BufferGeometry {
  const ringStride = STEM_RING_SIDES;
  const vertCount = (STEM_RINGS + 1) * ringStride;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const center: Array<[number, number, number]> = [];
  const tangent: Array<[number, number, number]> = [];
  for (let r = 0; r <= STEM_RINGS; r += 1) {
    const t = r / STEM_RINGS;
    const a = arc * t;
    center.push([Math.sin(a) * length, (1 - Math.cos(a)) * length * 0.55, 0]);
    const tx = Math.cos(a) * length * arc;
    const ty = Math.sin(a) * length * 0.55 * arc;
    const tl = Math.hypot(tx, ty) || 1;
    tangent.push([tx / tl, ty / tl, 0]);
  }
  for (let r = 0; r <= STEM_RINGS; r += 1) {
    const t = r / STEM_RINGS;
    const [tcx, tcy, tcz] = center[r]!;
    const [ttx, tty, ttz] = tangent[r]!;
    const useUp: [number, number, number] = Math.abs(tty) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    let nx = useUp[1] * ttz - useUp[2] * tty;
    let ny = useUp[2] * ttx - useUp[0] * ttz;
    let nz = useUp[0] * tty - useUp[1] * ttx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const bx = tty * nz - ttz * ny;
    const by = ttz * nx - ttx * nz;
    const bz = ttx * ny - tty * nx;
    const radius = (1 - t) * STEM_RADIUS * (1 - 0.7 * t);
    for (let i = 0; i < ringStride; i += 1) {
      const phi = (i / ringStride) * Math.PI * 2;
      const ox = Math.cos(phi) * radius;
      const oy = Math.sin(phi) * radius;
      const idx = (r * ringStride + i) * 3;
      positions[idx] = tcx + nx * ox + bx * oy;
      positions[idx + 1] = tcy + ny * ox + by * oy;
      positions[idx + 2] = tcz + nz * ox + bz * oy;
      const uvIdx = (r * ringStride + i) * 2;
      uvs[uvIdx] = i / ringStride;
      uvs[uvIdx + 1] = t;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < STEM_RINGS; r += 1) {
    for (let i = 0; i < ringStride; i += 1) {
      const a = r * ringStride + i;
      const b = r * ringStride + ((i + 1) % ringStride);
      const c = (r + 1) * ringStride + i;
      const d = (r + 1) * ringStride + ((i + 1) % ringStride);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Wind displacement. The bend weight is derived from `length(p)` of the vertex's local
 * position so the planted origin (length(p) ≤ 0.03) is stationary and the bend grows
 * smoothly along the petiole+leaf length. Two bands: slow gust + fast tip ripple.
 *
 * `shrubBentNormal` finite-differences `shrubDisplace` in the local tangent and bitangent
 * directions so the shaded normal follows the displaced surface.
 */
const SHRUB_WIND_GLSL = `
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uPhase;
  uniform float uDaylight;
  uniform vec3 uTint;

  float shrubWeight(vec3 p) {
    // Continuous position-derived weight. The smoothstep starts at 0 so the planted
    // origin (p == 0) is stationary, and ramps to 1 along the petiole+leaf reach so the
    // tip absorbs the full wind amplitude.
    return smoothstep(0.0, 0.85, length(p));
  }

  vec3 shrubDisplace(vec3 p) {
    float w = shrubWeight(p);
    float amp = 0.18 * w;
    float gust = 0.78 + 0.22 * sin(uTime * 0.21 + uPhase);
    float bend = sin(uTime * 1.45 + uPhase + p.y * 1.7) * (0.55 + 0.20 * sin(uTime * 2.9 + p.y));
    float flutter = sin(uTime * 5.1 + p.y * 4.7 + p.x * 3.1 + uPhase);
    vec3 worldOffset = vec3(uWind.x, 0.0, uWind.y) * (0.16 * bend * gust);
    worldOffset.y -= 0.018 * abs(bend);
    worldOffset += vec3(-uWind.y, 0.0, uWind.x) * (0.022 * flutter * w);
    return worldOffset * amp;
  }

  vec3 shrubBentNormal(vec3 position, vec3 objectNormal) {
    vec3 refUp = abs(objectNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(objectNormal, refUp));
    vec3 bitangent = normalize(cross(objectNormal, tangent));
    float eps = 0.001;
    vec3 dT = (shrubDisplace(position + tangent * eps) - shrubDisplace(position)) / eps;
    vec3 dB = (shrubDisplace(position + bitangent * eps) - shrubDisplace(position)) / eps;
    return normalize(cross(tangent + dT, bitangent + dB));
  }
`;

/**
 * Build a single cluster: a low arching rosette of 12-15 narrow pointed leaves
 * on short curved petioles. Each leaf grows outward from the centre point in
 * a different azimuth, arches upward, then droops at the tip — the reference
 * shows tight starfish-style rosettes, not cabbage-leaf stacks.
 */
function buildCluster(spec: ClusterSpec): BuiltCluster {
  const rand = mulberry32(0xC0FFEE ^ ((spec.seed * 0x9E3779B1) >>> 0));
  // Sparse rosette: 7-10 narrow pointed leaves per cluster.
  const leafCount = 7 + (spec.seed % 4);
  const pieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < leafCount; i += 1) {
    // Leaf azimuths evenly distributed around the cluster, with jitter so the
    // rosette doesn't read as a perfect circle.
    const leafYaw = (i / leafCount) * Math.PI * 2 + (rand() - 0.5) * 0.55;
    const cosLy = Math.cos(leafYaw);
    const sinLy = Math.sin(leafYaw);
    // Pitch range .55..1.15 — a few upright leaves, most leaning outward.
    const leafPitch = 0.55 + rand() * 0.60 + 0.10 * sinLy;
    const leafScale = 0.85 + rand() * 0.40;
    // Short shallow stem; visible cluster footprint comes from the leaves.
    const arc = 0.20 + rand() * 0.30;
    const stemLength = 0.18 + rand() * 0.15;

    const stemGeom = buildStemGeometry(arc, stemLength);
    stemGeom.applyMatrix4(new THREE.Matrix4().makeRotationY(leafYaw));
    pieces.push(stemGeom);

    // Petiole endpoint in pre-rotation local space, then rotated by leafYaw around Y.
    const tipXLocal = Math.sin(arc) * stemLength;
    const tipYLocal = (1 - Math.cos(arc)) * stemLength * 0.55;
    const tipXRot = tipXLocal * cosLy;
    const tipZRot = -tipXLocal * sinLy;
    // Rotate the leaf's length along its petiole and its width across it.
    const leafGeom = buildLeafGeometry();
    const leafMatrix = new THREE.Matrix4()
      .makeTranslation(tipXRot, tipYLocal, tipZRot)
      .multiply(new THREE.Matrix4().makeRotationY(leafYaw + Math.PI * 0.5))
      .multiply(new THREE.Matrix4().makeRotationX(leafPitch))
      .multiply(new THREE.Matrix4().makeScale(leafScale, leafScale, leafScale));
    leafGeom.applyMatrix4(leafMatrix);
    pieces.push(leafGeom);
  }
  const merged = mergeGeometries(pieces, false);
  if (!merged) throw new Error('shrubs: mergeGeometries failed');
  // Inflate the bounding volume to include the maximum wind displacement (~0.10 at the tip).
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.boundingBox!.expandByScalar(0.20);
  merged.boundingSphere!.radius += 0.20;
  for (const piece of pieces) piece.dispose();

  // Per-cluster foliage palette: subtle natural variation across the island.
  const hue = 0.27 + rand() * 0.05;
  const sat = 0.48 + rand() * 0.12;
  const light = 0.27 + rand() * 0.06;
  const tint = new THREE.Color().setHSL(hue, sat, light, THREE.SRGBColorSpace);

  // Scene-XZ wind counter-rotated by -spec.yaw and divided by spec.scale so the same
  // shader amplitude at every cluster produces a coherent world-space wind.
  const cosSpec = Math.cos(spec.yaw);
  const sinSpec = Math.sin(spec.yaw);
  const windLocalX = (WIND_X * cosSpec - WIND_Z * sinSpec) / spec.scale;
  const windLocalZ = (WIND_X * sinSpec + WIND_Z * cosSpec) / spec.scale;

  const uniforms: BuiltCluster['uniforms'] = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(windLocalX, windLocalZ) },
    uPhase: { value: spec.phase },
    uDaylight: { value: 1 },
    uTint: { value: tint },
  };

  const group = new THREE.Group();
  group.name = '';
  group.scale.setScalar(spec.scale);
  group.rotation.y = spec.yaw;

  const visibleMaterial = buildVisibleMaterial(uniforms);
  const mesh = new THREE.Mesh(merged, visibleMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = '';
  mesh.userData.explodeWithParent = true;
  const shadows = buildShadowMaterials(visibleMaterial, uniforms);
  mesh.customDepthMaterial = shadows.depth;
  mesh.customDistanceMaterial = shadows.distance;
  group.add(mesh);
  return { group, uniforms, shadows };
}

/**
 * Per-cluster visible material. Shader chunks:
 *   vertex   — wind displacement + bent normals + per-vecent vein attribute.
 *   fragment — tint multiplication, vein darkening from cross-width UV, transmission
 *              term driven by the scene's actual Three.js directionalLights.
 */
function buildVisibleMaterial(uniforms: BuiltCluster['uniforms']): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  mat.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = SHRUB_WIND_GLSL + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying float vRib;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      objectNormal = shrubBentNormal(position, objectNormal);
      // Vein from cross-width UV: peaks where v ≈ 0.5 (the rib spine).
      vRib = 1.0 - abs(uv.x - 0.5) * 2.0;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      transformed += shrubDisplace(position);`,
    );
    const fragHeader = `
      uniform vec3 uTint;
      uniform float uDaylight;
      varying float vRib;
    `;
    shader.fragmentShader = fragHeader + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec3 leafCol = diffuseColor.rgb * uTint;
      // Vein darkening along the central rib (vRib ~ 1 at the spine).
      leafCol *= mix(1.0, 0.78, pow(vRib, 1.4));
      diffuseColor.rgb = leafCol * (0.45 + 0.55 * uDaylight);`,
    );
    // Transmission: read directionalLights[i].direction and color, accumulate the back-side
    // shading the way Three.js does for translucent foliage. geometryNormal is the
    // view-space normal provided by Three.js at this injection point.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
        vec3 transmit = vec3(0.0);
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          vec3 lDir = directionalLights[i].direction;
          float ndl = max(0.0, -dot(normalize(geometryNormal), normalize(lDir)));
          transmit += directionalLights[i].color * (ndl * (1.0 - vRib) * 0.18);
        }
        reflectedLight.indirectDiffuse += diffuseColor.rgb * transmit;
      #endif`,
    );
  };
  return mat;
}

/**
 * Per-cluster depth + distance shadow materials with the same wind vertex displacement so
 * shadow geometry tracks the curl.
 */
function buildShadowMaterials(
  visible: THREE.MeshStandardMaterial,
  uniforms: BuiltCluster['uniforms'],
): { depth: THREE.Material; distance: THREE.Material } {
  const shadowOptions = {
    map: visible.map,
    alphaMap: visible.alphaMap,
    alphaTest: visible.alphaTest,
    side: visible.shadowSide ?? visible.side,
  };
  const depth = new THREE.MeshDepthMaterial({ ...shadowOptions, depthPacking: THREE.RGBADepthPacking });
  const dist = new THREE.MeshDistanceMaterial(shadowOptions);
  for (const mat of [depth, dist]) {
    mat.onBeforeCompile = (shader): void => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = SHRUB_WIND_GLSL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed += shrubDisplace(position);`,
      );
    };
  }
  return { depth, distance: dist };
}

function hash2(x: number, y: number, seed = 0.137): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + seed * 19.19) * 43758.5453;
  return v - Math.floor(v);
}

export function createShrubs(
  sampleAt: (x: number, z: number) => { y: number; onGrass: boolean; onSand: boolean },
): ShrubsResult {
  const group = new THREE.Group();
  group.name = 'Understory shrubs';
  const clusters: BuiltCluster[] = [];
  const count = 18;
  for (let i = 0; i < count; i += 1) {
    const angle = i * 2.399;
    const radius = 2.2 + (hash2(i, 5) - 0.5) * 2.4;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 0.8;
    const sample = sampleAt(x, z);
    if (!sample.onGrass && !sample.onSand) continue;
    const spec: ClusterSpec = {
      yaw: angle + Math.PI * 0.5 + (hash2(i, 7) - 0.5) * 0.6,
      scale: 0.6 + hash2(i, 11) * 0.55,
      seed: i * 17 + 3,
      phase: hash2(i, 19) * Math.PI * 2,
    };
    const built = buildCluster(spec);
    built.group.position.set(x, sample.y + 0.004, z);
    group.add(built.group);
    clusters.push(built);
  }
  let lastTime = 0;
  let disposed = false;
  return {
    group,
    tick(elapsed: number, reducedMotion: boolean, daylight?: number): void {
      if (disposed) return;
      // Reduced motion: hold the last advanced time so the pose freezes mid-cycle.
      if (!reducedMotion) lastTime = elapsed;
      const day = daylight === undefined ? 1 : Math.max(0, Math.min(1, daylight));
      for (const c of clusters) {
        c.uniforms.uTime.value = lastTime;
        c.uniforms.uDaylight.value = day;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const c of clusters) {
        c.shadows.depth.dispose();
        c.shadows.distance.dispose();
      }
    },
  };
}