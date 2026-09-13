import * as THREE from 'three';

export interface SurfaceMeta {
  version: number;
  nodeName: string;
  meshName: string;
  nodeMatrix: number[] | null;
  vertexCount: number;
  triangleCount: number;
  origin: number[];
  extent: number[];
  bytes: number[];
  roughness: number;
  metalness: number;
  materialName: string;
  sourceSha256: string;
  route: string;
}

/** Decode measured values only. No smoothing, reordering, remeshing or asset requests. */
export function decodeSurface(meta: SurfaceMeta, base64: string) {
  if (meta.version !== 1) throw new Error('Unsupported Ocean surface version');
  const raw = atob(base64);
  const stream = Uint8Array.from(raw, c => c.charCodeAt(0));
  const n = meta.vertexCount;
  const sizes = meta.bytes;
  if (sizes.length !== 4 || sizes[0] !== n * 6 || sizes[1] !== n * 2 || sizes[2] !== n * 3
    || sizes.reduce((a, b) => a + b, 0) !== stream.length) throw new Error('Ocean surface section size mismatch');
  const view = new DataView(stream.buffer);
  let cursor = 0;
  const position = new Float32Array(n * 3);
  for (let i = 0; i < position.length; i++, cursor += 2) {
    const axis = i % 3;
    position[i] = meta.origin[axis] + view.getUint16(cursor, true) / 65535 * meta.extent[axis];
  }
  if (cursor !== sizes[0]) throw new Error('Ocean position section mismatch');
  const normal = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x = stream[cursor++] / 127.5 - 1;
    let y = stream[cursor++] / 127.5 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const ox = x;
      x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
      y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
    }
    const length = Math.hypot(x, y, z);
    normal.set([x / length, y / length, z / length], i * 3);
  }
  if (cursor !== sizes[0] + sizes[1]) throw new Error('Ocean normal section mismatch');
  const colourBytes = stream.slice(cursor, cursor + sizes[2]);
  const colour = new Float32Array(n * 3);
  for (let i = 0; i < colour.length; i++) {
    const c = stream[cursor++] / 255;
    colour[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  const indicesStart = cursor;
  const index = new Uint32Array(meta.triangleCount * 3);
  let previous = 0;
  for (let i = 0; i < index.length; i++) {
    let value = 0;
    let multiplier = 1;
    for (let count = 0; ; count++) {
      if (cursor >= stream.length || count > 4) throw new Error('Invalid Ocean index varint');
      const byte = stream[cursor++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) break;
      multiplier *= 128;
    }
    previous += value % 2 === 0 ? value / 2 : -(value + 1) / 2;
    if (previous < 0 || previous >= n) throw new Error('Ocean index is out of range');
    index[i] = previous;
  }
  if (cursor - indicesStart !== sizes[3] || cursor !== stream.length) throw new Error('Ocean index section mismatch');
  return { position, normal, colour, colourBytes, index };
}

export function buildMeasuredSurface(meta: SurfaceMeta, base64: string): THREE.Group {
  const data = decodeSurface(meta, base64);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colour, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: meta.roughness, metalness: meta.metalness });
  material.name = meta.materialName;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = meta.meshName;
  mesh.castShadow = mesh.receiveShadow = true;
  const node = new THREE.Group();
  node.name = meta.nodeName;
  if (meta.nodeMatrix) {
    node.matrix.fromArray(meta.nodeMatrix);
    node.matrixAutoUpdate = false;
  }
  node.add(mesh);
  const root = new THREE.Group();
  root.name = 'Ocean measured surface';
  root.add(node);
  root.userData.provenance = { route: meta.route, sourceSha256: meta.sourceSha256, kind: 'measured-source-surface', independentProceduralGeometry: false };
  root.userData.surfaceMetrics = { vertices: meta.vertexCount, triangles: meta.triangleCount, sourceNodes: 1, runtimeTextures: 0 };
  return root;
}

/** A separate measured shading layer leaves the parity-checked geometry intact. */
export function applySurfaceRefinement(root: THREE.Group, base64: string, vertexCount: number): void {
  const raw = atob(base64);
  if (raw.length !== vertexCount * 6) throw new Error('Ocean shading layer size mismatch');
  const normals = new Float32Array(vertexCount * 3);
  const pbr = new Uint8Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    let x = (raw.charCodeAt(i * 4) | raw.charCodeAt(i * 4 + 1) << 8) / 32767.5 - 1;
    let y = (raw.charCodeAt(i * 4 + 2) | raw.charCodeAt(i * 4 + 3) << 8) / 32767.5 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const oldX = x;
      x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
      y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
    }
    const length = Math.hypot(x, y, z);
    normals.set([x / length, y / length, z / length], i * 3);
    pbr[i * 2] = raw.charCodeAt(vertexCount * 4 + i * 2);
    pbr[i * 2 + 1] = raw.charCodeAt(vertexCount * 4 + i * 2 + 1);
  }
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.geometry.getAttribute('position').count !== vertexCount) throw new Error('Ocean shading vertex order mismatch');
    object.geometry.setAttribute('measuredNormal', new THREE.BufferAttribute(normals, 3));
    object.geometry.setAttribute('measuredPbr', new THREE.BufferAttribute(pbr, 2, true));
    const material = object.material as THREE.MeshStandardMaterial;
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute vec3 measuredNormal;\nattribute vec2 measuredPbr;\nvarying vec2 vMeasuredPbr;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = measuredNormal;\nvMeasuredPbr = measuredPbr;');
      shader.fragmentShader = 'varying vec2 vMeasuredPbr;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vMeasuredPbr.x;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMeasuredPbr.y;');
    };
    material.customProgramCacheKey = () => 'ocean-measured-surface-refinement-v1';
    material.needsUpdate = true;
  });
  root.userData.surfaceRefinement = { geometryChanged: false, shading: 'vertex-sampled normal and PBR', runtimeTextures: 0 };
}
