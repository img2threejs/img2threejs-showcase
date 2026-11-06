import * as THREE from 'three';

const bound = new WeakMap();
const physicalInclude = '#include <envmap_physical_pars_fragment>';
const commonInclude = '#include <common>';
const worldposInclude = '#include <worldpos_vertex>';
const reflectToken = 'reflectVec = inverseTransformDirection( reflectVec, viewMatrix );';
const programSuffix = '|interior-box-probe-r180';
// Reflection components below this magnitude never reach a slab plane: treat the axis as parallel.
const parallelEpsilon = 1e-6;
const farDistance = 1e30;

const vertexPars = `
#ifdef USE_ENVMAP
varying vec3 vInteriorProbeWorld;
#endif
`;
const vertexAssign = `
#ifdef USE_ENVMAP
vInteriorProbeWorld = worldPosition.xyz;
#endif
`;
const fragmentPars = `
#ifdef USE_ENVMAP
varying vec3 vInteriorProbeWorld;
uniform vec3 interiorProbeBoxMin;
uniform vec3 interiorProbeBoxMax;
uniform vec3 interiorProbePosition;
vec3 interiorBoxProjectReflection( const in vec3 worldPos, const in vec3 direction ) {
  bvec3 parallel = lessThan( abs( direction ), vec3( ${parallelEpsilon.toExponential()} ) );
  vec3 safeDirection = mix( direction, vec3( 1.0 ), parallel );
  vec3 toMax = ( interiorProbeBoxMax - worldPos ) / safeDirection;
  vec3 toMin = ( interiorProbeBoxMin - worldPos ) / safeDirection;
  vec3 exitDistance = mix( max( toMax, toMin ), vec3( ${farDistance.toExponential()} ), parallel );
  float t = max( min( min( exitDistance.x, exitDistance.y ), exitDistance.z ), 0.0 );
  vec3 corrected = worldPos + direction * t - interiorProbePosition;
  return dot( corrected, corrected ) > 1e-12 ? normalize( corrected ) : direction;
}
#endif
`;
const projectedReflection = `vec3 interiorWorldReflect = inverseTransformDirection( reflectVec, viewMatrix );
			reflectVec = interiorBoxProjectReflection( vInteriorProbeWorld, interiorWorldReflect );`;

function requireOnce(source, token) {
  const index = typeof source === 'string' ? source.indexOf(token) : -1;
  if (index < 0 || source.indexOf(token, index + token.length) !== -1) {
    throw new Error(`Three.js shader-contract error: expected one ${token}. Keep the pinned Three r180 build.`);
  }
}

function vec3(value, name) {
  const v = value?.isVector3 ? [value.x, value.y, value.z] : value;
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(`${name} must be three finite numbers (glTF Y-up metres).`);
  }
  return new THREE.Vector3(v[0], v[1], v[2]);
}

function parseBox(box) {
  const min = vec3(box?.min, 'Probe box.min');
  const max = vec3(box?.max, 'Probe box.max');
  for (const axis of ['x', 'y', 'z']) {
    if (!(max[axis] > min[axis])) {
      throw new Error(`Probe box must have positive extent on ${axis}: min ${min[axis]}, max ${max[axis]}.`);
    }
  }
  return { min, max };
}

function parseProbe(position, box) {
  const p = vec3(position, 'Probe position');
  for (const axis of ['x', 'y', 'z']) {
    if (!(p[axis] > box.min[axis] && p[axis] < box.max[axis])) {
      throw new Error(`Probe position ${axis}=${p[axis]} must lie strictly inside the room box [${box.min[axis]}, ${box.max[axis]}].`);
    }
  }
  return p;
}

// Pure reference of interiorBoxProjectReflection in the fragment shader.
// A world position on or outside an exit plane clamps t to zero, exactly like the shader.
export function projectReflection(worldPos, direction, box, probePos) {
  const { min, max } = parseBox(box);
  const probe = parseProbe(probePos, { min, max });
  const position = vec3(worldPos, 'World position');
  const d = vec3(direction, 'Reflection direction');
  if (d.lengthSq() === 0) throw new Error('Reflection direction must be non-zero.');
  d.normalize();
  let t = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(d[axis]) < parallelEpsilon) continue;
    const toMax = (max[axis] - position[axis]) / d[axis];
    const toMin = (min[axis] - position[axis]) / d[axis];
    t = Math.min(t, Math.max(toMax, toMin));
  }
  t = Math.max(Math.min(t, farDistance), 0);
  const corrected = position.addScaledVector(d, t).sub(probe);
  return corrected.lengthSq() > 1e-12 ? corrected.normalize() : d;
}

export function uncorrectedReflection(direction) {
  const d = vec3(direction, 'Reflection direction');
  if (d.lengthSq() === 0) throw new Error('Reflection direction must be non-zero.');
  return d.normalize();
}

export function bindBoxProjectedProbe(material, { box, position } = {}) {
  if (!material?.isMeshStandardMaterial) {
    throw new Error('Box-projected probe requires a MeshStandardMaterial.');
  }
  const parsedBox = parseBox(box);
  const probe = parseProbe(position, parsedBox);
  const existing = bound.get(material);
  if (existing) {
    // Re-binding retargets the already-patched program instead of chaining a second patch.
    existing.boxMin.copy(parsedBox.min);
    existing.boxMax.copy(parsedBox.max);
    existing.position.copy(probe);
    return material;
  }
  const chunk = THREE.ShaderChunk.envmap_physical_pars_fragment;
  requireOnce(chunk, reflectToken);
  const patchedChunk = fragmentPars + chunk.replace(reflectToken, () => projectedReflection);
  const uniforms = {
    boxMin: parsedBox.min.clone(),
    boxMax: parsedBox.max.clone(),
    position: probe.clone()
  };
  const previousCompile = material.onBeforeCompile;
  const programKey = `${material.customProgramCacheKey()}${programSuffix}`;
  material.onBeforeCompile = function(shader, renderer) {
    previousCompile.call(this, shader, renderer);
    requireOnce(shader.fragmentShader, physicalInclude);
    requireOnce(shader.vertexShader, commonInclude);
    requireOnce(shader.vertexShader, worldposInclude);
    shader.uniforms.interiorProbeBoxMin = { value: uniforms.boxMin };
    shader.uniforms.interiorProbeBoxMax = { value: uniforms.boxMax };
    shader.uniforms.interiorProbePosition = { value: uniforms.position };
    shader.fragmentShader = shader.fragmentShader.replace(physicalInclude, () => patchedChunk);
    shader.vertexShader = shader.vertexShader
      .replace(commonInclude, () => commonInclude + vertexPars)
      .replace(worldposInclude, () => worldposInclude + vertexAssign);
  };
  material.customProgramCacheKey = () => programKey;
  bound.set(material, uniforms);
  material.needsUpdate = true;
  return material;
}
