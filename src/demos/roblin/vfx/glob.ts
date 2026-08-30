import * as THREE from 'three';
import { createRng } from './rng';

/**
 * What a goblin actually throws.
 *
 * The projectiles here were a perfect icosahedron with a white core and an additive halo — a
 * wizard's orb. Roblin is a barefoot skirmisher in tattered leather with crude steel strapped to
 * his shins; nothing about him says polished sphere. Two shapes replace it, and both are lumpy on
 * purpose:
 *
 *   GEL    a glob of bile. Deformed radially by seeded noise so no two are the same, shaded with a
 *          rim-lit falloff instead of a flat emissive so it reads as a translucent sac of liquid
 *          rather than a light bulb, and squashed along its own velocity the way a thrown droplet
 *          is. It tumbles slowly.
 *   SHARD  a piece of scavenged scrap. Faceted, much darker in the body, with a hot leading edge
 *          where it is biting the air. It tumbles fast, and it is deliberately small: a handful of
 *          grit thrown hard, not an artillery shell.
 *
 * Both geometries are built once and shared. The seeded deformation means a screenshot of the same
 * cast is reproducible, which is the same rule the particle field follows.
 */

export type GlobStyle = 'gel' | 'shard';

const cache = new Map<string, THREE.BufferGeometry>();

/** A lumpy ball. `variants` distinct shapes are cached and picked round-robin by the caller. */
export function globGeometry(style: GlobStyle, variant: number): THREE.BufferGeometry {
  const key = `${style}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const detail = style === 'gel' ? 3 : 1;
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const rng = createRng(0x9e37 + variant * 7919);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  // Radial displacement from a few summed sines of the vertex direction. Cheap, seamless on a
  // sphere (it is a function of direction only, so shared vertices agree), and enough to break the
  // silhouette — which is the only thing that matters at the size these are drawn.
  const a = rng.range(1.5, 3.5);
  const b = rng.range(2.5, 5.5);
  const c = rng.range(3.5, 7.5);
  const phase = rng.range(0, Math.PI * 2);
  const amount = style === 'gel' ? 0.28 : 0.42;

  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    const n = Math.sin(v.x * a + phase) * Math.sin(v.y * b + phase * 1.7)
      + 0.6 * Math.sin(v.z * c - phase) * Math.sin(v.x * b + phase);
    v.multiplyScalar(1 + n * amount * 0.5);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  position.needsUpdate = true;

  // Scrap is flat-shaded, and a ShaderMaterial has no `flatShading` flag — that switch only exists
  // on the built-in materials. Flat shading here has to come from the GEOMETRY: splitting the
  // index gives every triangle its own three vertices, so `computeVertexNormals` writes one face
  // normal per corner instead of averaging across the facet edges.
  const out = style === 'shard' ? geometry.toNonIndexed() : geometry;
  if (out !== geometry) geometry.dispose();
  out.computeVertexNormals();
  cache.set(key, out);
  return out;
}

const GEL_VERTEX = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalMatrix * normal;
    vViewDir = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Rim-lit, not flat-emissive.
 *
 * A solid bright core is what makes a projectile read as a light source. Bile is not a light
 * source — it is a wet sac that catches light at its edge and is murkier through the middle. So the
 * rim (where the surface turns away from the eye) is the bright part and the centre sits back
 * toward the deep colour, which is the opposite of the halo maths used for the magic bolts.
 */
const GEL_FRAGMENT = /* glsl */ `
  uniform vec3 uSkin;
  uniform vec3 uDeep;
  uniform float uGlow;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
    float rim = pow(1.0 - facing, 1.4);
    float belly = pow(facing, 1.2);
    // The belly carries real weight, not a token amount. Additive blending cannot DARKEN, so a
    // rim-only glob contributes almost nothing across its middle and reads as a faint wire ring
    // rather than as a body — the first version of this was very nearly invisible in flight.
    // Measured back down from 1.5 / 2.2: at those weights the glob plus its halo plus its
    // travelling light clipped to a white mass and washed the whole figure green.
    vec3 colour = uDeep * belly * 0.85 + uSkin * rim * 1.15;
    // A wet highlight where the surface is most edge-on to the viewer.
    colour += uSkin * pow(1.0 - facing, 7.0) * 1.1;
    gl_FragColor = vec4(colour * uGlow, 1.0);
  }
`;

const SHARD_FRAGMENT = /* glsl */ `
  uniform vec3 uSkin;
  uniform vec3 uDeep;
  uniform float uGlow;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    // Flat-shaded scrap: the facet either catches the light or it does not, so the ramp is hard.
    float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
    float lit = smoothstep(0.15, 0.75, facing);
    vec3 colour = mix(uDeep * 0.9, uSkin, lit);
    // The leading edge glows from friction; everything else stays dull metal.
    colour += uSkin * pow(1.0 - facing, 5.0) * 1.1;
    gl_FragColor = vec4(colour * uGlow, 1.0);
  }
`;

export function globMaterial(style: GlobStyle): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSkin: { value: new THREE.Color(0xffffff) },
      uDeep: { value: new THREE.Color(0x000000) },
      uGlow: { value: 1 },
    },
    vertexShader: GEL_VERTEX,
    fragmentShader: style === 'gel' ? GEL_FRAGMENT : SHARD_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
