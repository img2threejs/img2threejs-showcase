import * as THREE from 'three';

const GRID_WIDTH = 43;
const GRID_HEIGHT = 42;
const MASK_BASE64 = 'AID/BwAAgAfgAQAAw/84AADG/z8HABjwf2AAIP7/fwaAwf//YwCG//kfBhD8zv8gwMBjxgcDAh4/HhAQ4PjxkOAA//+DnAf4/x/kPcD+vyDvAfb/BPkPsQAkyH8cB+BB/kcYAAbxPAAAAMCDAwAAAA94AAAAPMD//3/4Af7///8H4P///x8A/v///wDg////AwD+//8PAOD//z8AAP7/fwAAwA/8AQAAON8BAAAA/AAAAADgBwAAAAAcAAAAAGAAAAAAAAMAAAAAGAAAAADAAAAAAAAPAAAAAHgAAAAAgAEAAA==';
const UV_BOUNDS = [0.14599609375, 0.48583984375, 0.228515625, 0.56689453125] as const;
// The source median 0.006512090793 is carried by an 8-bit linear vertex-colour stream, whose
// decoded dark value is 2/255. Use that same representable value for cleaned logo-background
// samples so the measured mask does not introduce a darker quantisation island.
const HOODIE_BACKGROUND_LINEAR = 2 / 255;
const GRAPHIC_LINEAR = 128 / 255;
const FRAGMENT_GRID_WIDTH = 169;
const FRAGMENT_GRID_HEIGHT = 166;
const FRAGMENT_MASK_BASE64 = 'AAAAAAAAAAAA//9/AAAAAAAAAAAAAAAAAAAAAAD+////fwAAAAAAAAAAAAAAAAAAAPD//////z8AAAAAAAAAAAAAAAAAAPz///////8DAAAAAAAAAAAAAAAAAP//PwAA//8/AAAAAAAAAAAAAAAA4P8/AAAAAPz/BwAAAAAAAAAAAAAA8P8DAAAAAAD/PwAAAAAAAAAAAAAA+P8AAAAAAADw/wEAAAAAAAAAAAAA/h8AAP//fwAA/h8AAAAAAAAAAAAA/wcA/P///38A4P8AAAAAAAAAAAAA/wOA//////8PAP8HAAAAAAAAAACA/wDw////////AfA/AAAAAAAAAACAfwD8////////H4D/AAAAAAAAAADAPwD+/////////wH8BwAAAAAAAADAHwD//////////w/gHwAAAAAAAADgHwDw/////////x8A/wAAAAAAAADgDwAA/////////wcA/AMAAAAAAADgDwAAwP//////PwAA4A8AAAAAAADgB/ABAPz/////BwAAAD8AAAAAAADgB/B/AMD/////AQDAA/wAAAAAAADgB/D/fwD///9/AMD/D/AHAAAAAADgB+D//3/+////4P//P8AfAAAAAADgB8D//////////////wB/AAAAAADgB4D//////////////wH8AAAAAADABwD//////////////wPwAwAAAADABwDA/////////////wPADwAAAADADwAAAAD+P/zj////AQAAPwAAAADADwAAAAD8H+AB/wcAAAAA/AAAAACADwAAAAD+H4AB/A8AAAAA8AMAAACADwDg////PwAA+P8DAAAAwAcAAACAHwDA/////z/g8////z8AAB8AAAAAHwAA///////g//////8AAH4AAAAAHwAA/v/////B//////8AAPgAAAAAPgAA/P//4P+D//////8BAOADAAAAPgAA8P9/AP8D/A/4//8DAMAHAAAAfAAA4P9/APwD8AfA//8DAAAfAAAAfAAAwP9/APAH4AcA//8HAAA+AAAA+AAAAP//AMAP4A8A/v8PAAD4AAAA8AAAAP7/AIA/4B8A+P8fAADwAQAA8AEAAPz/AQD//x8A8P8fAADgAwAA4AMAAPD/AwD+/z8A4P8/AACADwAAwAMAAOD/BwD8/38AwP8/AAAAHgAAwAcAAID/DwD4//8AgP9/AAAAPAAAgA8AAAD/HwDw//8BAP9/AAAB+AAAAB8AAAD8fwDw//8HAP//AAAH8AEAAB4AAADw/wHg//8PAP7/AAAOwAMAAD4AAADg/wfw//8/AP7/AAA8gA8AAH8AAACA/x/w////AP7/AQB4AB8AwH8AAAAA/v//////B///AQDgAD4AwP8AAAAA/P//////////AwDAA/wHwP8BAAAA+P//////////BwCAB/g/wP8DAAAA8P//////////DwAAD/D/gP8HAAAA4P//////////HwAAHsD/g/8PAAAAwP//////////PwAAPID/D/8fAAAAgP//////////fwAAcAD/H/8/AAAAAP///////////QAA4AD+f/5/AAAAAH7+////////+QEA4AP8//z/AAAAAPz4////////8QMAwAf4//n/AQAAAPjB////////4AMAgAfw//P/AwAAAPAD////////wAcAAA/g/+f/BwAAAOAH/P//////gA8AAB7A////DwAAAMAP+P//////AB8AADzA////HwAAAIAf8Pv/////Az4AAHiA////PwAAAAA/8AP////jB3wAAPgA/////wAABgB88AcA+ACAH/gAAPAB/v///wEADAD44AcAAAAAP/gBAOAB/P///wMAOADw4QcAAAAA/PADAMAD+P///w8AcADg4wcAAAAA8OMDAIAD+P///x8A8AHA5w8AAAAA4McHAIAH8P/f/z8A8AeA/w8AAAAAgN8PAAAP4P+//38A/n8A/g8AAAAAAP8PAAAOwP9///8B/P8A/A8AAAAAAPwfAAAewP9//v8DwD8A8A8AAAAAAPA/AAAcgP//+P8PAD4A4A8AAAAAAMA/AAAcgP//8f8fADgAgA8AAAAAAAA/AAA4AP//w/9/AHAAAAAAAAAAAAA8AAAAAP7/g///AWAAAAAAAAAAAAAAAAAAAP7/B/7/A8AAAAAAAAAAAAAAAAAAAP7/B/D/DwAAAAAAAAAAAAAAAAAAAPz/B8D/PwAAAAAAAAAAAAAAAAAAAPz/DwDw/wAAAAAAAAAAAAAAAAAAAPz/BwDA/wMAAAAAAAAAAAAAAAAAAPz/AwCA/w8AAAAAAAAAAAAAAAAAAPh/AAAA/z8AAAAAAAAAAAAAAAAAAPh/AAAA/P8AAAAAAAAAAAAAAAAAAPj/AAAA+P8DAAAAAAAAAAAAAAAAAPj/AQAA8P8fAAAAAAAAAAAAAAAAAPz/AQAAwP//AAAAAAAAAAAAAAAAAPz/AwAAgP//BwAAAAD4fwAAAAAAAP7/BwAAAP7//wDA////////AQAAgP//BwAAAPz///////////////8A+P//DwAAAPD/////////////////////DwAAAOD/////////////////////HwAAAID/////////////////////HwAAAAD/////////////////////HwAAAAD8////////////////////PwAAAADw////////////////////PwAAAADg////////////////////PwAAAACA////////////////////fwAAAAAA/v//////////////////fwAAAAAA+P//////////////////fwAAAAAA8P//////////////////fwAAAAAAwP///////////////////wAAAAAAAP///////////////////wAAAAAAAPz//////////////////wAAAAAAAPD//////////////////wAAAAAAAMD//////////////////wAAAAAAAAD//////////////////wAAAAAAAAD8/////////////////wAAAAAAAADw/////////////////wAAAAAAAADg/////////////////wEAAAAAAAAA/////////////////wAAAAAAAAAA/P///////////////wAAAAAAAAAA8P///////////////wAAAAAAAAAAwP///////////////wAAAAAAAAAAAP7/////////////fwAAAAAAAAAAAPj/////////////fwAAAAAAAAAAAOD/////////////fwAAAAAAAAAAAAD/////DwD/////PwAAAAAAAAAAAAD4////AwD4////HwAAAAAAAAAAAADg////AQCA////HwAAAAAAAAAAAAAA////AAAA/P//DwAAAAAAAAAAAAAA+P//AAAA8P//BwAAAAAAAAAAAAAAwP9/APwPwP//AwAAAAAAAAAAAAAAAPz/AP//AP//AAAAAAAAAAAAAAAAAOD/AP//B/x/AAAAAAAAAAAAAAAAAAD+gf//H/gfAAAAAAAAAAAAAAAAAADAAf//f+ADAAAAAAAAAAAAAAAAAAAAAP///wAAAAAAAAAAAAAAAAAAAAAAAP///wMAAAAAAAAAAAAAAAAAAAAAAP7//wcAAAAAAAAAAAAAAAAAAAAAAPz//w8AAAAAAAAAAAAAAAAAAAAAAPj//x8AAAAAAAAAAAAAAAAAAAAAAOD//x8AAAAAAAAAAAAAAAAAAAAAAID//z8AAAAAAAAAAAAAAAAAAAAAAAB+/D8AAAAAAAAAAAAAAAAAAAAAAAB4/D8AAAAAAAAAAAAAAAAAAAAAAAAA+B8AAAAAAAAAAAAAAAAAAAAAAAAA+A8AAAAAAAAAAAAAAAAAAAAAAAAA8AMAAAAAAAAAAAAAAAAAAAAAAAAA4AMAAAAAAAAAAAAAAAAAAAAAAAAAwA8AAAAAAAAAAAAAAAAAAAAAAAAAgB8AAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAAAAAAAAAAAAAAAAAAAPABAAAAAAAAAAAAAAAAAAAAAAAAAOADAAAAAAAAAAAAAAAAAAAAAAAAAMAHAAAAAAAAAAAAAAAAAAAAAAAAAIAPAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAD/AwAAAAAAAAAAAAAAAAAAAAAAAAD/DwAAAAAAAAAAAAAAAAAAAAAAAAD/HwAAAAAAAAAAAAAAAAAAAAAAAAD+fwAAAAAAAAAAAAAAAAAAAAAAAAD+/wAAAAAAAAAAAAAAAAAAAAAAAAD8/wEAAAAAAAAAAAAAAAAAAAAAAAD4/wMAAAAAAAAAAAAAAAAAAAAAAADw/wcAAAAAAAAAAAAAAAAAAAAAAADA/w8AAAAAAAAAAAAAAAAAAAAAAACA/w8AAAAAAAAAAAAAAAAAAAAAAAAA/h8AAAAAAAAAAAAAAAAAAAAAAAAA+B8AAAAAAAAAAAAAAAAAAAAAAAAAwAcAAAAAAAAAAAAA';

function decodeFragmentMaskWords(): number[] {
  const binary = atob(FRAGMENT_MASK_BASE64);
  const words: number[] = [];
  for (let offset = 0; offset < binary.length; offset += 4) {
    words.push((
      binary.charCodeAt(offset)
      | ((binary.charCodeAt(offset + 1) || 0) << 8)
      | ((binary.charCodeAt(offset + 2) || 0) << 16)
      | ((binary.charCodeAt(offset + 3) || 0) << 24)
    ) >>> 0);
  }
  return words;
}

// Basis: x, y, z, x^2, xy, xz, y^2, yz, z^2, 1. Offline inverse fit from
// the 625 measured node-102 UV/world samples. UV RMS is 0.0001226818452;
// the worst fitted u/v residual is 0.2521/0.0825 of one emitted mask cell.
const WORLD_TO_UV_COEFFICIENTS: readonly (readonly [number, number])[] = [
  [-1.611567328387171, 0.02610839154267927],
  [0.07581483662269314, 1.5970117182120482],
  [0.30626536580966923, 1.6697615276348639],
  [-0.015289276717403226, 0.571251568425954],
  [0.9253102987293419, -0.025749120248046337],
  [1.942755163784553, -0.053647847671591024],
  [-0.0364548085531548, -0.4289685910913567],
  [-0.23852636570502972, -2.2478381275083668],
  [-0.7168995227196329, -1.4888119336020031],
  [0.14454677594997178, -0.31127303202588713],
];

// Basis: u, v, u^2, uv, v^2, 1. Offline least-squares fit from node 102's
// source UVs to its world-space surface; RMS 0.767603 mm, maximum 2.161781 mm.
const QUADRATIC_COEFFICIENTS: readonly (readonly [number, number])[] = [
  [-0.6116095075903892, 0.5607559457346368],
  [0.2306859497217723, 1.2099460077091104],
  [0.0261507786957679, -1.4276885136427506],
  [-1.1622506354667548, -0.042670645672259096],
  [-0.007626709238441704, 0.01328386084621332],
  [0.1076229521444506, -0.07061590492586797],
];

function decodeMask(): Uint8Array {
  const binary = atob(MASK_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isActive(mask: Uint8Array, column: number, row: number): boolean {
  const index = row * GRID_WIDTH + column;
  return (mask[index >> 3] & (1 << (index & 7))) !== 0;
}

function uvToWorldXY(u: number, v: number): [number, number] {
  const basis = [u, v, u * u, u * v, v * v, 1];
  let x = 0;
  let y = 0;
  for (let i = 0; i < basis.length; i += 1) {
    x += basis[i] * QUADRATIC_COEFFICIENTS[i][0];
    y += basis[i] * QUADRATIC_COEFFICIENTS[i][1];
  }
  return [x, y];
}

export function applyMeasuredHoodieColours(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!position || !colour || position.count !== colour.count) return;

  const mask = decodeMask();
  const cells: Array<{ x: number; y: number; active: boolean }> = [];
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    const v = THREE.MathUtils.lerp(UV_BOUNDS[1], UV_BOUNDS[3], (row + 0.5) / GRID_HEIGHT);
    for (let column = 0; column < GRID_WIDTH; column += 1) {
      const u = THREE.MathUtils.lerp(UV_BOUNDS[0], UV_BOUNDS[2], (column + 0.5) / GRID_WIDTH);
      const [x, y] = uvToWorldXY(u, v);
      cells.push({ x, y, active: isActive(mask, column, row) });
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
  }

  let clearedVertexCount = 0;
  let graphicVertexCount = 0;
  for (let i = 0; i < position.count; i += 1) {
    colour.setXYZ(i, HOODIE_BACKGROUND_LINEAR, HOODIE_BACKGROUND_LINEAR, HOODIE_BACKGROUND_LINEAR);
    clearedVertexCount += 1;
    const x = position.getX(i);
    const y = position.getY(i);
    if (position.getZ(i) <= 0.05 || x < xMin || x > xMax || y < yMin || y > yMax) continue;
    let nearest = cells[0];
    let nearestSquared = Number.POSITIVE_INFINITY;
    for (const cell of cells) {
      const squared = (cell.x - x) ** 2 + (cell.y - y) ** 2;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        nearest = cell;
      }
    }
    if (nearest.active) {
      colour.setXYZ(i, GRAPHIC_LINEAR, GRAPHIC_LINEAR, GRAPHIC_LINEAR);
      graphicVertexCount += 1;
    }
  }
  colour.needsUpdate = true;
  geometry.userData.measuredHoodieColours = {
    sourceNode: 102,
    method: 'measured-uv-mask-nearest-output-vertex',
    uvFitRmsMillimetres: 0.7676027278603756,
    uvFitMaximumMillimetres: 2.161780918384321,
    maskBlockWorldMillimetres: 2.45,
    clearedVertexCount,
    graphicVertexCount,
    textureShipped: false,
    authoredResolutionNote: 'The measured mask is quantised to existing Surface Nets vertices; no UV atlas is copied.',
  };
}

export function applyMeasuredHoodieNormalFilter(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!position || !normal || !index) return;

  const sums = new Float32Array(position.count * 3);
  const counts = new Uint16Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3;
    sums[offset] = normal.getX(vertex);
    sums[offset + 1] = normal.getY(vertex);
    sums[offset + 2] = normal.getZ(vertex);
    counts[vertex] = 1;
  }

  const addNeighbour = (target: number, neighbour: number) => {
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
  geometry.userData.measuredHoodieNormalFilter = {
    sourceNode: 102,
    method: 'single-one-ring-average-of-recomputed-surface-nets-normals',
    filteredVertexCount: position.count,
    passCount: 1,
    geometryChanged: false,
  };
}

export function applyMeasuredHoodieFragmentMask(material: THREE.MeshPhysicalMaterial): void {
  const fragmentMaskWords = decodeFragmentMaskWords();
  const maskWords = fragmentMaskWords.map((word) => `${word}u`).join(', ');
  const uTerms = WORLD_TO_UV_COEFFICIENTS.map((coefficient, index) =>
    `${coefficient[0]} * measuredHoodieBasis[${index}]`).join(' + ');
  const vTerms = WORLD_TO_UV_COEFFICIENTS.map((coefficient, index) =>
    `${coefficient[1]} * measuredHoodieBasis[${index}]`).join(' + ');
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredHoodiePosition;\nvarying vec3 vMeasuredHoodieFrontNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMeasuredHoodiePosition = position;',
      )
      .replace(
        '#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvMeasuredHoodieFrontNormal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMeasuredHoodiePosition;
        varying vec3 vMeasuredHoodieFrontNormal;
        const uint measuredHoodieMask[${fragmentMaskWords.length}] = uint[${fragmentMaskWords.length}](${maskWords});
        float measuredHoodieMaskAt(ivec2 cell) {
          if (cell.x < 0 || cell.x >= ${FRAGMENT_GRID_WIDTH} || cell.y < 0 || cell.y >= ${FRAGMENT_GRID_HEIGHT}) return 0.0;
          int bitIndex = cell.y * ${FRAGMENT_GRID_WIDTH} + cell.x;
          uint word = measuredHoodieMask[bitIndex >> 5];
          return float((word >> uint(bitIndex & 31)) & 1u);
        }
        float measuredHoodiePouchLeft(float y) {
          if (y < 0.417076975107193 || y > 0.5398591160774231) return 1.0;
          if (y <= 0.44009862653911114) return mix(-0.08875175282359123, -0.0914229229092598, (y - 0.417076975107193) / (0.44009862653911114 - 0.417076975107193));
          if (y <= 0.4554463941603899) return mix(-0.0914229229092598, -0.09016050547361373, (y - 0.44009862653911114) / (0.4554463941603899 - 0.44009862653911114));
          if (y <= 0.47079416178166866) return mix(-0.09016050547361373, -0.09018915817141533, (y - 0.4554463941603899) / (0.47079416178166866 - 0.4554463941603899));
          if (y <= 0.4861419294029474) return mix(-0.09018915817141533, -0.09027038842439651, (y - 0.47079416178166866) / (0.4861419294029474 - 0.47079416178166866));
          if (y <= 0.5014896970242262) return mix(-0.09027038842439651, -0.07405602484941483, (y - 0.4861419294029474) / (0.5014896970242262 - 0.4861419294029474));
          if (y <= 0.516837464645505) return mix(-0.07405602484941483, -0.053758996799588205, (y - 0.5014896970242262) / (0.516837464645505 - 0.5014896970242262));
          return mix(-0.053758996799588205, -0.04269697107374668, (y - 0.516837464645505) / (0.5398591160774231 - 0.516837464645505));
        }
        float measuredHoodiePouchRight(float y) {
          if (y < 0.417076975107193 || y > 0.5398591160774231) return -1.0;
          if (y <= 0.44009862653911114) return mix(0.08875208675861358, 0.09142296761274338, (y - 0.417076975107193) / (0.44009862653911114 - 0.417076975107193));
          if (y <= 0.4554463941603899) return mix(0.09142296761274338, 0.09016050338745117, (y - 0.44009862653911114) / (0.4554463941603899 - 0.44009862653911114));
          if (y <= 0.47079416178166866) return mix(0.09016050338745117, 0.09018920406699181, (y - 0.4554463941603899) / (0.47079416178166866 - 0.4554463941603899));
          if (y <= 0.4861419294029474) return mix(0.09018920406699181, 0.09027042686939239, (y - 0.47079416178166866) / (0.4861419294029474 - 0.47079416178166866));
          if (y <= 0.5014896970242262) return mix(0.09027042686939239, 0.07405607402324678, (y - 0.4861419294029474) / (0.5014896970242262 - 0.4861419294029474));
          if (y <= 0.516837464645505) return mix(0.07405607402324678, 0.05375902764499187, (y - 0.5014896970242262) / (0.516837464645505 - 0.5014896970242262));
          return mix(0.05375902764499187, 0.04269697926938533, (y - 0.516837464645505) / (0.5398591160774231 - 0.516837464645505));
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        float measuredPouchLeft = measuredHoodiePouchLeft(vMeasuredHoodiePosition.y);
        float measuredPouchRight = measuredHoodiePouchRight(vMeasuredHoodiePosition.y);
        float measuredPouchBoundary = min(
          min(vMeasuredHoodiePosition.x - measuredPouchLeft, measuredPouchRight - vMeasuredHoodiePosition.x),
          min(vMeasuredHoodiePosition.y - 0.417076975107193, 0.5398591160774231 - vMeasuredHoodiePosition.y)
        );
        float measuredPouchFront = step(0.05, vMeasuredHoodiePosition.z);
        float measuredPouchInside = step(0.0, measuredPouchBoundary) * measuredPouchFront;
        float measuredPouchSeam = (
          1.0 - smoothstep(0.0, 0.005580127018922193, abs(measuredPouchBoundary))
        ) * measuredPouchFront;
        float measuredPouchUpperTaper = step(
          0.5014896970242262,
          vMeasuredHoodiePosition.y
        ) * measuredPouchInside;
        float measuredPouchNormalStrength = max(
          measuredPouchInside * 0.3687413503011901,
          max(measuredPouchSeam, measuredPouchUpperTaper)
        );
        normal = normalize(mix(
          normal,
          normalize(vMeasuredHoodieFrontNormal),
          measuredPouchNormalStrength
        ));`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float measuredHoodieBasis[10];
        measuredHoodieBasis[0] = vMeasuredHoodiePosition.x;
        measuredHoodieBasis[1] = vMeasuredHoodiePosition.y;
        measuredHoodieBasis[2] = vMeasuredHoodiePosition.z;
        measuredHoodieBasis[3] = vMeasuredHoodiePosition.x * vMeasuredHoodiePosition.x;
        measuredHoodieBasis[4] = vMeasuredHoodiePosition.x * vMeasuredHoodiePosition.y;
        measuredHoodieBasis[5] = vMeasuredHoodiePosition.x * vMeasuredHoodiePosition.z;
        measuredHoodieBasis[6] = vMeasuredHoodiePosition.y * vMeasuredHoodiePosition.y;
        measuredHoodieBasis[7] = vMeasuredHoodiePosition.y * vMeasuredHoodiePosition.z;
        measuredHoodieBasis[8] = vMeasuredHoodiePosition.z * vMeasuredHoodiePosition.z;
        measuredHoodieBasis[9] = 1.0;
        vec2 measuredHoodieUv = vec2(${uTerms}, ${vTerms});
        vec2 measuredHoodieGrid = (measuredHoodieUv - vec2(${UV_BOUNDS[0]}, ${UV_BOUNDS[1]}))
          / vec2(${UV_BOUNDS[2] - UV_BOUNDS[0]}, ${UV_BOUNDS[3] - UV_BOUNDS[1]})
          * vec2(${FRAGMENT_GRID_WIDTH}.0, ${FRAGMENT_GRID_HEIGHT}.0) - 0.5;
        ivec2 measuredHoodieCell = ivec2(floor(measuredHoodieGrid));
        vec2 measuredHoodieFraction = fract(measuredHoodieGrid);
        float measuredHoodieMaskTop = mix(
          measuredHoodieMaskAt(measuredHoodieCell),
          measuredHoodieMaskAt(measuredHoodieCell + ivec2(1, 0)),
          measuredHoodieFraction.x
        );
        float measuredHoodieMaskBottom = mix(
          measuredHoodieMaskAt(measuredHoodieCell + ivec2(0, 1)),
          measuredHoodieMaskAt(measuredHoodieCell + ivec2(1, 1)),
          measuredHoodieFraction.x
        );
        float measuredHoodieMaskValue = mix(
          measuredHoodieMaskTop,
          measuredHoodieMaskBottom,
          measuredHoodieFraction.y
        );
        float measuredHoodieEdge = max(fwidth(measuredHoodieMaskValue), 0.04);
        float measuredHoodieGraphic = smoothstep(
          0.5 - measuredHoodieEdge,
          0.5 + measuredHoodieEdge,
          measuredHoodieMaskValue
        );
        float measuredHoodieInside = step(${UV_BOUNDS[0]}, measuredHoodieUv.x)
          * step(measuredHoodieUv.x, ${UV_BOUNDS[2]})
          * step(${UV_BOUNDS[1]}, measuredHoodieUv.y)
          * step(measuredHoodieUv.y, ${UV_BOUNDS[3]})
          * step(0.05, vMeasuredHoodiePosition.z);
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          vec3(${HOODIE_BACKGROUND_LINEAR}),
          measuredHoodieInside
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          vec3(${GRAPHIC_LINEAR}),
          measuredHoodieInside * measuredHoodieGraphic
        );`,
      );
  };
  material.customProgramCacheKey = () => 'mars-cat-measured-hoodie-fragment-v4';
  material.needsUpdate = true;
  material.userData.measuredHoodieFragment = {
    sourceNode: 102,
    method: 'fragment-evaluated-measured-mask-through-quadratic-world-to-uv-fit',
    maskGrid: [FRAGMENT_GRID_WIDTH, FRAGMENT_GRID_HEIGHT],
    sourcePixelsPerMaskCell: 1,
    inverseUvFitRms: 0.00012268184522244658,
    maximumCellResidual: [0.25210755, 0.08247366],
    textureShipped: false,
    geometryChanged: false,
    measuredPouchNormalReplacement: {
      sourceConnectedComponentRank: 4,
      sourceBounds: [
        [-0.0914229229092598, 0.417076975107193, 0.09734845161437988],
        [0.09142296761274338, 0.5398591160774231, 0.14270012080669403],
      ],
      outlineBandCount: 8,
      edgeTransitionMetres: 0.005580127018922193,
      edgeTransitionSource: 'node-102 triangle-sampling support at 2.5 mm cell and factor 0.5',
      measuredNormalBlend: 0.3687413503011901,
      upperTaperFullNormalFromY: 0.5014896970242262,
      blendDerivation: 'interpolation from current 0.0154573216555 and upper-taper candidate 0.00781601417063 to reference 0.00936768399124 pouch luminance variation',
      geometryChanged: false,
    },
  };
}
