import * as THREE from 'three';

const BODY_BLUE = new THREE.Color(0, 0.2581828529215958, 0.6724431569576875);
const EAR_BLUE = new THREE.Color(0.003346535763899161, 0.057805430191, 0.147027266498);

// World-space extent of the GLB body node's measured dark ear-colour samples.
const EAR_SAMPLE_BOUNDS = {
  absXMin: 0.05106925219297409,
  absXMax: 0.15325167775154114,
  yMin: 0.9997096061706543,
  yMax: 1.1488336324691772,
  zMin: -0.05746208503842354,
  zMax: 0.005543542560189962,
} as const;

// Full node-97 ear shell measured from the GLB. 1,466 / 1,520 samples inside this extent are
// exactly BODY_BLUE or EAR_BLUE; all exact EAR_BLUE samples are inside EAR_SAMPLE_BOUNDS.
const EAR_SHELL_BOUNDS = {
  absXMin: 0.04002951830625534,
  absXMax: 0.16496016085147858,
  yMin: 0.9903268814086914,
  yMax: 1.1604304313659668,
  zMin: -0.10245244950056076,
  zMax: 0.029973071068525314,
} as const;

// Fourth-order least-squares classifier fitted offline to the 920 source samples inside
// EAR_SAMPLE_BOUNDS. The lateral coordinate is abs(x), so the two ears are a reflection.
const SPATIAL_MEAN = [0.1068980646846087, 1.0909261633520542, -0.024083046758586652] as const;
const SPATIAL_SCALE = [0.030420567041659297, 0.047737192870040385, 0.014844192237623397] as const;
const SPATIAL_THRESHOLD = 0.4707389618475831;
const SPATIAL_POWERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 0, 2], [0, 1, 1], [0, 2, 0],
  [1, 0, 1], [1, 1, 0], [2, 0, 0], [0, 0, 3], [0, 1, 2], [0, 2, 1], [0, 3, 0],
  [1, 0, 2], [1, 1, 1], [1, 2, 0], [2, 0, 1], [2, 1, 0], [3, 0, 0], [0, 0, 4],
  [0, 1, 3], [0, 2, 2], [0, 3, 1], [0, 4, 0], [1, 0, 3], [1, 1, 2], [1, 2, 1],
  [1, 3, 0], [2, 0, 2], [2, 1, 1], [2, 2, 0], [3, 0, 1], [3, 1, 0], [4, 0, 0],
];
const SPATIAL_COEFFICIENTS = [
  1.2062440500363714, -0.9991597957422288, 1.1146289575925996, 0.047304454773657946,
  -0.6571296698296071, -0.08487748589765567, -0.0738789063078754, -0.5064250435480774,
  0.255764744988468, -0.060843021983033665, -0.1999439754458653, -0.802066930397414,
  0.8723188846343735, -0.7377159292757118, -0.18233976397599116, -0.08062859405538554,
  0.151501026545735, 0.20210435808913887, -0.84350327716569, -0.07472684454267055,
  -0.0626115553263424, -0.14363908950176774, -0.20171435480132108, 0.31446180725576434,
  -0.14406524697475248, -0.003926100737187173, -0.022886018090561275, -0.03220847867255372,
  0.09714617505197266, -0.08638721422939229, 0.2387319801252606, -0.49000086772455437,
  0.051308233339059976, -0.07568888573761048, -0.08436433716492774,
] as const;

const SPATIAL_SCORE_GLSL = SPATIAL_POWERS.map(([px, py, pz], index) => {
  const factors = [
    ...Array.from({ length: px }, () => 'measuredEarX'),
    ...Array.from({ length: py }, () => 'measuredEarY'),
    ...Array.from({ length: pz }, () => 'measuredEarZ'),
  ];
  return `${SPATIAL_COEFFICIENTS[index]} * ${factors.length ? factors.join(' * ') : '1.0'}`;
}).join('\n          + ');

function squaredDistance(r: number, g: number, b: number, target: THREE.Color): number {
  return (r - target.r) ** 2 + (g - target.g) ** 2 + (b - target.b) ** 2;
}

export function applyMeasuredEarPalette(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!position || !colour || position.count !== colour.count) return;

  let changedVertexCount = 0;
  for (let i = 0; i < position.count; i += 1) {
    const absX = Math.abs(position.getX(i));
    const y = position.getY(i);
    const z = position.getZ(i);
    if (
      absX < EAR_SAMPLE_BOUNDS.absXMin || absX > EAR_SAMPLE_BOUNDS.absXMax
      || y < EAR_SAMPLE_BOUNDS.yMin || y > EAR_SAMPLE_BOUNDS.yMax
      || z < EAR_SAMPLE_BOUNDS.zMin || z > EAR_SAMPLE_BOUNDS.zMax
    ) continue;

    const r = colour.getX(i);
    const g = colour.getY(i);
    const b = colour.getZ(i);
    const target = squaredDistance(r, g, b, EAR_BLUE) < squaredDistance(r, g, b, BODY_BLUE)
      ? EAR_BLUE
      : BODY_BLUE;
    colour.setXYZ(i, target.r, target.g, target.b);
    changedVertexCount += 1;
  }
  colour.needsUpdate = true;
  geometry.userData.measuredEarPalette = {
    sourceNode: 97,
    method: 'nearest-measured-two-colour-palette-inside-source-sample-bounds',
    bounds: EAR_SAMPLE_BOUNDS,
    changedVertexCount,
    authoredResolutionNote: 'Texture transitions below the cell are quantised; no UV atlas is copied.',
  };
}

export function applyMeasuredEarSpatialPalette(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!position || !colour || position.count !== colour.count) return;

  let darkVertexCount = 0;
  let bodyVertexCount = 0;
  for (let i = 0; i < position.count; i += 1) {
    const absX = Math.abs(position.getX(i));
    const y = position.getY(i);
    const z = position.getZ(i);
    if (
      absX < EAR_SAMPLE_BOUNDS.absXMin || absX > EAR_SAMPLE_BOUNDS.absXMax
      || y < EAR_SAMPLE_BOUNDS.yMin || y > EAR_SAMPLE_BOUNDS.yMax
      || z < EAR_SAMPLE_BOUNDS.zMin || z > EAR_SAMPLE_BOUNDS.zMax
    ) continue;

    const normalized = [
      (absX - SPATIAL_MEAN[0]) / SPATIAL_SCALE[0],
      (y - SPATIAL_MEAN[1]) / SPATIAL_SCALE[1],
      (z - SPATIAL_MEAN[2]) / SPATIAL_SCALE[2],
    ];
    let score = 0;
    for (let term = 0; term < SPATIAL_POWERS.length; term += 1) {
      const [px, py, pz] = SPATIAL_POWERS[term];
      score += SPATIAL_COEFFICIENTS[term]
        * normalized[0] ** px * normalized[1] ** py * normalized[2] ** pz;
    }
    const target = score >= SPATIAL_THRESHOLD ? EAR_BLUE : BODY_BLUE;
    colour.setXYZ(i, target.r, target.g, target.b);
    if (target === EAR_BLUE) darkVertexCount += 1;
    else bodyVertexCount += 1;
  }
  colour.needsUpdate = true;
  geometry.userData.measuredEarPalette = {
    sourceNode: 97,
    method: 'reflection-symmetric-fourth-order-world-space-classifier',
    sourceSampleCount: 920,
    sourceClassificationAccuracy: 0.9380434782608695,
    candidateNearestSourceAccuracy: 0.9331140350877193,
    previousCandidateNearestSourceAccuracy: 0.9291666666666667,
    bounds: EAR_SAMPLE_BOUNDS,
    darkVertexCount,
    bodyVertexCount,
    textureShipped: false,
  };
}

export function applyMeasuredEarFragmentPalette(material: THREE.MeshPhysicalMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredEarPosition;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMeasuredEarPosition = position;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredEarPosition;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float measuredEarAbsX = abs(vMeasuredEarPosition.x);
        float measuredEarInside = step(${EAR_SAMPLE_BOUNDS.absXMin}, measuredEarAbsX)
          * step(measuredEarAbsX, ${EAR_SAMPLE_BOUNDS.absXMax})
          * step(${EAR_SAMPLE_BOUNDS.yMin}, vMeasuredEarPosition.y)
          * step(vMeasuredEarPosition.y, ${EAR_SAMPLE_BOUNDS.yMax})
          * step(${EAR_SAMPLE_BOUNDS.zMin}, vMeasuredEarPosition.z)
          * step(vMeasuredEarPosition.z, ${EAR_SAMPLE_BOUNDS.zMax});
        float measuredEarShellInside = step(${EAR_SHELL_BOUNDS.absXMin}, measuredEarAbsX)
          * step(measuredEarAbsX, ${EAR_SHELL_BOUNDS.absXMax})
          * step(${EAR_SHELL_BOUNDS.yMin}, vMeasuredEarPosition.y)
          * step(vMeasuredEarPosition.y, ${EAR_SHELL_BOUNDS.yMax})
          * step(${EAR_SHELL_BOUNDS.zMin}, vMeasuredEarPosition.z)
          * step(vMeasuredEarPosition.z, ${EAR_SHELL_BOUNDS.zMax});
        float measuredEarX = (measuredEarAbsX - ${SPATIAL_MEAN[0]}) / ${SPATIAL_SCALE[0]};
        float measuredEarY = (vMeasuredEarPosition.y - ${SPATIAL_MEAN[1]}) / ${SPATIAL_SCALE[1]};
        float measuredEarZ = (vMeasuredEarPosition.z - ${SPATIAL_MEAN[2]}) / ${SPATIAL_SCALE[2]};
        float measuredEarScore = ${SPATIAL_SCORE_GLSL};
        float measuredEarWidth = max(fwidth(measuredEarScore), 0.002);
        float measuredEarDark = smoothstep(
          ${SPATIAL_THRESHOLD} - measuredEarWidth,
          ${SPATIAL_THRESHOLD} + measuredEarWidth,
          measuredEarScore
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          vec3(${BODY_BLUE.r}, ${BODY_BLUE.g}, ${BODY_BLUE.b}),
          measuredEarShellInside
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          vec3(${EAR_BLUE.r}, ${EAR_BLUE.g}, ${EAR_BLUE.b}),
          measuredEarInside * measuredEarDark
        );`,
      );
  };
  material.customProgramCacheKey = () => 'mars-cat-measured-ear-fragment-v4';
  material.needsUpdate = true;
  material.userData.measuredEarFragment = {
    sourceNode: 97,
    method: 'fragment-evaluated-fourth-order-world-space-classifier',
    sourceSampleCount: 920,
    sourceClassificationAccuracy: 0.9380434782608695,
    measuredShellSampleCount: 1520,
    exactTwoColourShellFraction: 0.9644736842105263,
    visibilityCorrection: 'clear full measured shell, then reapply classifier only in sample bounds',
    textureShipped: false,
    geometryChanged: false,
  };
}

/**
 * One topology-preserving normal-filter pass over the measured ear extent. Positions and indices
 * remain byte-for-byte unchanged; only the recomputed Surface Nets normals are averaged across each
 * vertex's one-ring neighbours. This is an experimental render correction for the fine 2.5 mm body
 * tier, whose geometry is closer to the source but exposes more cell-scale normal variation.
 */
export function applyMeasuredEarNormalFilter(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!position || !normal || !index) return;

  const earMask = new Uint8Array(position.count);
  const sums = new Float32Array(position.count * 3);
  const counts = new Uint16Array(position.count);
  let filteredVertexCount = 0;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const absX = Math.abs(position.getX(vertex));
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    if (
      absX < EAR_SAMPLE_BOUNDS.absXMin || absX > EAR_SAMPLE_BOUNDS.absXMax
      || y < EAR_SAMPLE_BOUNDS.yMin || y > EAR_SAMPLE_BOUNDS.yMax
      || z < EAR_SAMPLE_BOUNDS.zMin || z > EAR_SAMPLE_BOUNDS.zMax
    ) continue;
    earMask[vertex] = 1;
    const offset = vertex * 3;
    sums[offset] = normal.getX(vertex);
    sums[offset + 1] = normal.getY(vertex);
    sums[offset + 2] = normal.getZ(vertex);
    counts[vertex] = 1;
    filteredVertexCount += 1;
  }

  const addNeighbour = (target: number, neighbour: number) => {
    if (!earMask[target]) return;
    const offset = target * 3;
    sums[offset] += normal.getX(neighbour);
    sums[offset + 1] += normal.getY(neighbour);
    sums[offset + 2] += normal.getZ(neighbour);
    counts[target] += 1;
  };
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const a = index.getX(triangle);
    const b = index.getX(triangle + 1);
    const c = index.getX(triangle + 2);
    addNeighbour(a, b); addNeighbour(a, c);
    addNeighbour(b, a); addNeighbour(b, c);
    addNeighbour(c, a); addNeighbour(c, b);
  }

  for (let vertex = 0; vertex < position.count; vertex += 1) {
    if (!earMask[vertex]) continue;
    const offset = vertex * 3;
    const length = Math.hypot(sums[offset], sums[offset + 1], sums[offset + 2]) || 1;
    normal.setXYZ(
      vertex,
      sums[offset] / length,
      sums[offset + 1] / length,
      sums[offset + 2] / length,
    );
  }
  normal.needsUpdate = true;
  geometry.userData.measuredEarNormalFilter = {
    sourceNode: 97,
    method: 'single-one-ring-average-of-recomputed-surface-nets-normals',
    filteredVertexCount,
    passCount: (geometry.userData.measuredEarNormalFilter?.passCount ?? 0) + 1,
    geometryChanged: false,
  };
}
