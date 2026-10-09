import * as THREE from 'three';

export interface GrassSample {
  y: number;
  onGrass: boolean;
  onSand: boolean;
}

export interface Grass {
  readonly group: THREE.Group;
  tick(elapsed: number, reducedMotion: boolean, daylight?: number): void;
  dispose(): void;
}

// Matches the wind direction used by palmWind / campfire.
const WIND_DIR = new THREE.Vector2(0.92, 0.39);

const BLADE_SEGMENTS = 6;
const BLADE_WIDTH_SEGMENTS = 2;

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

// Shader chunk. grassDisplace uses t = clamp(p.y / aLength); grassNormalFinite does
// forward differences in two perpendicular tangent directions, not an analytical Jacobian.
const WIND_GLSL_COMMON = /* glsl */ `
  attribute float aHeightT;
  attribute float aAzimuth;
  attribute float aLength;
  attribute float aBladeSeed;

  uniform float grassTime;
  uniform float grassWindX;
  uniform float grassWindZ;
  uniform float grassNight;

  varying float vHeightT;
  varying float vBladeSeed;
  varying float vNight;

  vec3 grassWindOffset(vec3 p) {
    float t = clamp(p.y / max(0.0001, aLength), 0.0, 1.0);
    float rootDecay = smoothstep(0.0, 0.35, t);
    float tipWeight = smoothstep(0.4, 1.0, t);
    float gust = 0.78 + 0.22 * sin(grassTime * 0.27 + aBladeSeed * 6.28);
    float bend = sin(grassTime * 1.7 + aBladeSeed * 6.283 + aAzimuth) * gust;
    float flutter = sin(grassTime * 4.3 + aBladeSeed * 12.0 + t * 4.0);
    vec3 wind = vec3(grassWindX, 0.0, grassWindZ);
    float mag = (0.30 * aLength) * bend * rootDecay
              + 0.01 * flutter * tipWeight;
    return wind * mag + vec3(0.0, -0.012 * abs(bend) * tipWeight, 0.0);
  }

  vec3 grassDisplace(vec3 p) {
    return p + grassWindOffset(p);
  }

  // Finite-difference normal: pick T perpendicular to n, B = cross(n, T), sample
  // grassDisplace at p±ε·T and p±ε·B, cross the two result vectors.
  vec3 grassNormalFinite(vec3 p, vec3 n) {
    vec3 helper = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(helper, n));
    vec3 B = cross(n, T);
    float eps = 0.001;
    vec3 dT = grassDisplace(p + T * eps) - grassDisplace(p - T * eps);
    vec3 dB = grassDisplace(p + B * eps) - grassDisplace(p - B * eps);
    return normalize(cross(dT, dB));
  }
`;

function buildTuftGeometry(
  rand: () => number,
  bladeHeight: number,
  bladeCount: number,
): THREE.BufferGeometry {
  const segV = BLADE_SEGMENTS;
  const segU = BLADE_WIDTH_SEGMENTS;
  const vertPerBlade = (segV + 1) * (segU + 1);
  const triPerBlade = segV * segU * 2;
  const totalVerts = bladeCount * vertPerBlade;
  const totalTris = bladeCount * triPerBlade;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  const aHeightT = new Float32Array(totalVerts);
  const aAzimuth = new Float32Array(totalVerts);
  const aLength = new Float32Array(totalVerts);
  const aBladeSeed = new Float32Array(totalVerts);

  let vi = 0;
  let ii = 0;

  for (let b = 0; b < bladeCount; b += 1) {
    // Per-blade seeded variation. Lean (radial frequency) gives the blade a
    // gentle outward curl; tipTwist drifts the azimuth along the length so
    // older bases sit under younger tips; all blades are pointed (no forks).
    const azimuth = rand() * Math.PI * 2;
    const lean = (rand() * 0.30 + 0.06) * (rand() < 0.5 ? -1 : 1);
    const curlStrength = 0.04 + rand() * 0.07;
    const tipTwist = (rand() * 0.25 + 0.05) * (rand() < 0.5 ? -1 : 1);
    const lengthFactor = 0.78 + rand() * 0.42;
    const phase = rand() * 6.283;
    const sinL = Math.sin(lean);
    const actualLength = bladeHeight * lengthFactor;

    // Root offsets scattered inside a small radius so blades don't share a
    // single vertical column.
    const rootX = (rand() - 0.5) * 0.08;
    const rootZ = (rand() - 0.5) * 0.08;

    const slice: Array<{ x: number; y: number; z: number; wT: number; t: number }> = [];

    for (let v = 0; v <= segV; v += 1) {
      const t = v / segV;
      // Width goes to 0 at the tip so the blade tapers to a point.
      const width = 0.022 * (1 - t);
      // Quadratic curl: the blade bends through the local Z axis (forward),
      // giving a real C-shape rather than a flat strip.
      const curl = Math.pow(t, 1.8) * curlStrength * (1.0 + sinL * 4.0);
      const localY = t * actualLength;
      const localZ = curl;
      const twistAz = azimuth + lean * 0.4 + tipTwist * t;

      for (let u = 0; u <= segU; u += 1) {
        const wT = u / segU;
        // Midrib lift multiplied by sin(PI*t) so it goes to 0 at base and tip,
        // ensuring the apex verts coincide in a single pointed vertex.
        const fold = (1 - Math.abs(wT * 2 - 1)) * 0.5 * Math.sin(Math.PI * t);
        const localX = (wT - 0.5) * width * 2.0;
        const localZFold = localZ + fold * 0.006;

        const cosT = Math.cos(twistAz);
        const sinT = Math.sin(twistAz);
        const rx = localX * cosT + localZFold * sinT;
        const rz = -localX * sinT + localZFold * cosT;

        positions[vi * 3 + 0] = rx + rootX;
        positions[vi * 3 + 1] = localY;
        positions[vi * 3 + 2] = rz + rootZ;

        aHeightT[vi] = t;
        aAzimuth[vi] = twistAz;
        aLength[vi] = actualLength;
        aBladeSeed[vi] = phase;
        uvs[vi * 2 + 0] = wT;
        uvs[vi * 2 + 1] = t;

        slice.push({ x: positions[vi * 3 + 0], y: localY, z: positions[vi * 3 + 2], wT, t });
        vi += 1;
      }
    }

    // Per-vertex rest normals from the actual V-fold surface tangents. At the
    // tip slice (v == segV) width = 0 so the in-slice tangent collapses; copy
    // the previous slice's normal into the tip verts to keep a defined outward
    // normal there.
    const baseIdx = b * vertPerBlade;
    for (let v = 0; v <= segV; v += 1) {
      for (let u = 0; u <= segU; u += 1) {
        const vIdx = baseIdx + v * (segU + 1) + u;
        if (v === segV) {
          const src = (segV - 1) * (segU + 1) + u;
          normals[vIdx * 3 + 0] = normals[(baseIdx + src) * 3 + 0];
          normals[vIdx * 3 + 1] = normals[(baseIdx + src) * 3 + 1];
          normals[vIdx * 3 + 2] = normals[(baseIdx + src) * 3 + 2];
          continue;
        }
        const prevV = slice[(v > 0 ? v - 1 : 0) * (segU + 1) + u];
        const nextV = slice[(v < segV ? v + 1 : segV) * (segU + 1) + u];
        const prevU = slice[v * (segU + 1) + (u > 0 ? u - 1 : 0)];
        const nextU = slice[v * (segU + 1) + (u < segU ? u + 1 : segU)];
        const tanV = { x: nextV.x - prevV.x, y: nextV.y - prevV.y, z: nextV.z - prevV.z };
        const tanU = { x: nextU.x - prevU.x, y: nextU.y - prevU.y, z: nextU.z - prevU.z };
        const nx = tanV.y * tanU.z - tanV.z * tanU.y;
        const ny = tanV.z * tanU.x - tanV.x * tanU.z;
        const nz = tanV.x * tanU.y - tanV.y * tanU.x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-8) {
          normals[vIdx * 3 + 0] = nx / len;
          normals[vIdx * 3 + 1] = ny / len;
          normals[vIdx * 3 + 2] = nz / len;
        } else if (v > 0) {
          const src = (v - 1) * (segU + 1) + u;
          normals[vIdx * 3 + 0] = normals[(baseIdx + src) * 3 + 0];
          normals[vIdx * 3 + 1] = normals[(baseIdx + src) * 3 + 1];
          normals[vIdx * 3 + 2] = normals[(baseIdx + src) * 3 + 2];
        } else {
          normals[vIdx * 3 + 0] = 0;
          normals[vIdx * 3 + 1] = 1;
          normals[vIdx * 3 + 2] = 0;
        }
      }
    }

    for (let v = 0; v < segV; v += 1) {
      for (let u = 0; u < segU; u += 1) {
        const a = baseIdx + v * (segU + 1) + u;
        const b0 = a + 1;
        const c = a + (segU + 1);
        const d = c + 1;
        indices[ii * 3 + 0] = a;
        indices[ii * 3 + 1] = c;
        indices[ii * 3 + 2] = b0;
        indices[ii * 3 + 3] = b0;
        indices[ii * 3 + 4] = c;
        indices[ii * 3 + 5] = d;
        ii += 2;
      }
    }
  }

  // Root-to-tip vertex colour gradient.
  const aColor = new Float32Array(totalVerts * 3);
  const rootColor = new THREE.Color(0x4d6d22);
  const midColor = new THREE.Color(0x7da534);
  const tipColor = new THREE.Color(0xc7c068);
  const tmp = new THREE.Color();
  for (let i = 0; i < totalVerts; i += 1) {
    const t = aHeightT[i];
    if (t < 0.55) {
      tmp.copy(rootColor).lerp(midColor, t / 0.55);
    } else {
      tmp.copy(midColor).lerp(tipColor, (t - 0.55) / 0.45);
    }
    aColor[i * 3 + 0] = tmp.r;
    aColor[i * 3 + 1] = tmp.g;
    aColor[i * 3 + 2] = tmp.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(aColor, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aHeightT', new THREE.BufferAttribute(aHeightT, 1));
  geometry.setAttribute('aAzimuth', new THREE.BufferAttribute(aAzimuth, 1));
  geometry.setAttribute('aLength', new THREE.BufferAttribute(aLength, 1));
  geometry.setAttribute('aBladeSeed', new THREE.BufferAttribute(aBladeSeed, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Inflate so wind tip displacement doesn't push verts outside the cull sphere.
  geometry.boundingBox!.expandByScalar(0.2);
  geometry.boundingSphere!.radius += 0.2;
  return geometry;
}

function buildSharedMaterials(uniforms: Record<string, THREE.IUniform>): {
  standard: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  distance: THREE.MeshDistanceMaterial;
} {
  const standard = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  standard.vertexColors = true;
  // USE_UV forces the standard shader to declare vUv so the midrib vein can read it.
  standard.defines = { ...standard.defines, USE_UV: '' };
  standard.onBeforeCompile = (shader) => {
    shader.uniforms.grassTime = uniforms.grassTime;
    shader.uniforms.grassWindX = uniforms.grassWindX;
    shader.uniforms.grassWindZ = uniforms.grassWindZ;
    shader.uniforms.grassNight = uniforms.grassNight;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL_COMMON}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         objectNormal = grassNormalFinite(position, objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `
        vHeightT = aHeightT;
        vBladeSeed = aBladeSeed;
        vNight = grassNight;
        vec3 transformed = grassDisplace(position);
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vHeightT;
         varying float vBladeSeed;
         varying float vNight;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `
        #include <opaque_fragment>
        #if NUM_DIR_LIGHTS > 0
          // Thin-leaf backscatter: brighten the transmitted colour when a directional
          // light is behind the blade. vViewPosition points from frag → camera, so
          // viewDir is normalize(vViewPosition). 0.35 is a restrained cap.
          vec3 viewDirN = normalize(vViewPosition);
          vec3 scatter = vec3(0.0);
          for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
            vec3 lDir = normalize(directionalLights[i].direction);
            float back = max(0.0, -dot(normal, lDir));
            float wrap = 0.35 + 0.65 * pow(max(0.0, dot(viewDirN, -lDir)), 3.0);
            scatter += directionalLights[i].color * (back * wrap * 0.35);
          }
          gl_FragColor.rgb += gl_FragColor.rgb * scatter;
        #endif
        // Single midrib darkening along the blade length (parallel to blade axis).
        float midrib = 1.0 - smoothstep(0.0, 0.04, abs(vUv.x - 0.5));
        gl_FragColor.rgb *= mix(1.0, 0.78, midrib * smoothstep(0.0, 0.3, vHeightT));
        // Tip dry-bleach: slight desaturation near the pointed tip.
        float tipBleach = smoothstep(0.65, 1.0, vHeightT);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.08, 1.02, 0.85), tipBleach * 0.55);
        // Night darkening.
        gl_FragColor.rgb *= mix(1.0, 0.32, vNight);
        `,
      );
  };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.grassTime = uniforms.grassTime;
    shader.uniforms.grassWindX = uniforms.grassWindX;
    shader.uniforms.grassWindZ = uniforms.grassWindZ;
    shader.uniforms.grassNight = uniforms.grassNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL_COMMON}`)
      .replace('#include <begin_vertex>', `vec3 transformed = grassDisplace(position);`);
  };

  const distance = new THREE.MeshDistanceMaterial();
  distance.onBeforeCompile = (shader) => {
    shader.uniforms.grassTime = uniforms.grassTime;
    shader.uniforms.grassWindX = uniforms.grassWindX;
    shader.uniforms.grassWindZ = uniforms.grassWindZ;
    shader.uniforms.grassNight = uniforms.grassNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL_COMMON}`)
      .replace('#include <begin_vertex>', `vec3 transformed = grassDisplace(position);`);
  };

  return { standard, depth, distance };
}

export function createGrass(
  sampleAt: (x: number, z: number) => GrassSample,
): Grass {
  const group = new THREE.Group();
  group.name = 'Grass tufts';

  // Per-instance uniforms — multiple Grass instances stay isolated.
  const uniforms: Record<string, THREE.IUniform> = {
    grassTime: { value: 0 },
    grassWindX: { value: WIND_DIR.x },
    grassWindZ: { value: WIND_DIR.y },
    grassNight: { value: 0 },
  };
  const { standard, depth, distance } = buildSharedMaterials(uniforms);

  const tufts: THREE.Group[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  // Hash-based placement so tufts read as natural irregular clumps rather than
  // a polar spiral; up to 90 candidates, sampled to onGrass surface only.
  for (let i = 0; i < 90; i += 1) {
    const seed = 0x600D0000 + i * 1013;
    const rand = mulberry32(seed);
    const angle = rand() * Math.PI * 2;
    const radius = 0.55 + rand() * 2.85;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 0.85;
    const sample = sampleAt(x, z);
    if (!sample.onGrass) continue;

    // 6..12 blades per tuft (compact clumps, not brushes); heights .10..0.24.
    const bladeCount = 6 + Math.floor(rand() * 7);
    const bladeHeight = 0.10 + rand() * 0.14;
    const geometry = buildTuftGeometry(rand, bladeHeight, bladeCount);

    const mesh = new THREE.Mesh(geometry, standard);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depth;
    mesh.customDistanceMaterial = distance;
    mesh.name = '';
    mesh.userData.explodeWithParent = false;

    const tuft = new THREE.Group();
    tuft.name = '';
    tuft.add(mesh);
    tuft.position.set(x, sample.y, z);
    group.add(tuft);
    tufts.push(tuft);
    geometries.push(geometry);
  }

  let disposed = false;
  // Reduced motion holds the clock; the displacement code path is never changed for it.
  let frozenTime = 0;
  const tick = (elapsed: number, reducedMotion: boolean, daylight = 1): void => {
    if (disposed) return;
    if (!reducedMotion) frozenTime = elapsed;
    uniforms.grassTime.value = frozenTime;
    uniforms.grassNight.value = THREE.MathUtils.clamp(1 - daylight, 0, 1);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const tuft of tufts) {
      const mesh = tuft.children[0] as THREE.Mesh;
      if (mesh) {
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
      tuft.removeFromParent();
    }
    tufts.length = 0;
    geometries.length = 0;
    standard.dispose();
    depth.dispose();
    distance.dispose();
  };

  return { group, tick, dispose };
}