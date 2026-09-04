import * as THREE from 'three';

// Derived from the GLB-target Laplacian between the accepted one-ring and full two-ring renders:
// (0.09281027 - 0.08888900) / (0.09281027 - 0.08758163).
const SHOE_SECOND_RING_SHADING_BLEND = 0.7499598365923069;

export function applyMeasuredShoeShadingAttribute(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!position || !normal || !index) return;

  const sums = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3;
    sums[offset] = normal.getX(vertex);
    sums[offset + 1] = normal.getY(vertex);
    sums[offset + 2] = normal.getZ(vertex);
  }
  const addNeighbour = (target: number, neighbour: number) => {
    const offset = target * 3;
    sums[offset] += normal.getX(neighbour);
    sums[offset + 1] += normal.getY(neighbour);
    sums[offset + 2] += normal.getZ(neighbour);
  };
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const a = index.getX(triangle);
    const b = index.getX(triangle + 1);
    const c = index.getX(triangle + 2);
    addNeighbour(a, b); addNeighbour(a, c);
    addNeighbour(b, a); addNeighbour(b, c);
    addNeighbour(c, a); addNeighbour(c, b);
  }

  const shadingNormal = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3;
    const targetLength = Math.hypot(sums[offset], sums[offset + 1], sums[offset + 2]) || 1;
    const x = THREE.MathUtils.lerp(
      normal.getX(vertex),
      sums[offset] / targetLength,
      SHOE_SECOND_RING_SHADING_BLEND,
    );
    const y = THREE.MathUtils.lerp(
      normal.getY(vertex),
      sums[offset + 1] / targetLength,
      SHOE_SECOND_RING_SHADING_BLEND,
    );
    const z = THREE.MathUtils.lerp(
      normal.getZ(vertex),
      sums[offset + 2] / targetLength,
      SHOE_SECOND_RING_SHADING_BLEND,
    );
    const length = Math.hypot(x, y, z) || 1;
    shadingNormal[offset] = x / length;
    shadingNormal[offset + 1] = y / length;
    shadingNormal[offset + 2] = z / length;
  }
  geometry.setAttribute('shoeShadingNormal', new THREE.BufferAttribute(shadingNormal, 3));
  geometry.userData.measuredShoeShading = {
    method: 'separate-fractional-second-ring-shading-attribute',
    secondRingBlend: SHOE_SECOND_RING_SHADING_BLEND,
    shadedVertexCount: position.count,
    geometryNormalChanged: false,
    positionsChanged: false,
    indicesChanged: false,
  };
}

export function applyMeasuredShoeShadingMaterial(material: THREE.MeshPhysicalMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 shoeShadingNormal;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nobjectNormal = shoeShadingNormal;',
      );
  };
  material.customProgramCacheKey = () => 'mars-cat-shoe-separate-shading-normal-v1';
  material.userData.measuredShoeShading = {
    method: 'shoeShadingNormal-replaces-objectNormal-for-lighting-only',
    secondRingBlend: SHOE_SECOND_RING_SHADING_BLEND,
    geometryNormalChanged: false,
  };
}
