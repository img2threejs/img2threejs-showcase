import * as THREE from 'three';

/**
 * Shared per-role evidence installed on geometry.userData.surfaceEvidence.
 * `triangleClasses` is per-original-triangle byte mask; populated only where the
 * shared contract requires a semantic classifier (campfire / palm). `glassBounds`
 * is populated only for the lamp. Both are plain Uint8Array / number-triple.
 */
export interface SurfaceEvidence {
  sourceVertexCount: number;
  sourceTriangleCount: number;
  triangleClasses?: Uint8Array;
  glassBounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
}

/** Per-role metadata + measured scalars. */
export interface SurfaceMeta {
  version: number;
  nodeChain: Array<{ name: string | null; matrix: number[]; isMeshNode: boolean }>;
  meshNodeName: string | null;
  meshName: string | null;
  materialName: string | null;
  meshNodeWorldMatrix: number[];
  vertexCount: number;
  triangleCount: number;
  origin: number[];
  extent: number[];
  bounds: { min: number[]; max: number[]; extent: number[] };
  bytes: number[];
  baseColorFactor: number[];
  roughnessFactor: number;
  metalnessFactor: number;
  alphaMode: string;
  alphaCutoff: number;
  doubleSided: boolean;
  emissiveFactor: number[];
  medianBaseColor: number[];
  medianRoughness: number;
  medianMetalness: number;
  baseColorTextureTransform: { offset: number[]; scale: number[]; rotation: number };
  baseColorWrapS: number;
  baseColorWrapT: number;
  baseColorMinFilter: number;
  baseColorMagFilter: number;
  samplerFlipY: boolean;
  sourceSha256: string;
  sourceBytes: number;
  route: string;
  /** Canonical section hashes, including the re-derivable original base64 form. */
  codecHashes: { position: string; normal: string; colour: string; index: string; stream: string; base64: string };
}

/** Decoded numeric buffers used by the runtime factory. */
export interface DecodedSurface {
  position: Float32Array;
  normal: Float32Array;
  colour: Float32Array;
  colourBytes: Uint8Array;
  index: Uint32Array;
}

/** Inline base64 -> Uint8Array. Used for chunk decode and triangleClasses. */
export function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Decode bounded imports with backpressure; yield between chunks for UI input. */
export async function loadCompressedSurface(
  chunks: ReadonlyArray<() => Promise<{ default: string }>>,
): Promise<Uint8Array> {
  if (chunks.length === 0) {
    throw new Error('Tropical Island compressed surface: empty chunk list');
  }
  let index = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller): Promise<void> {
      try {
        const mod = await chunks[index]();
        controller.enqueue(bytesFromBase64(mod.default));
        index += 1;
        if (index >= chunks.length) controller.close();
        else await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const inflated = compressed.pipeThrough(new DecompressionStream('gzip'));
  const response = new Response(inflated);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('Tropical Island compressed surface: empty after gunzip');
  }
  return new Uint8Array(buffer);
}

/** Decode one role's measured stream from a pre-decompressed byte buffer. */
export function decodeSurface(meta: SurfaceMeta, stream: Uint8Array): DecodedSurface {
  if (meta.version !== 1) throw new Error('Unsupported Tropical Island surface version');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const n = meta.vertexCount;
  const sizes = meta.bytes;
  const expectedTotal = sizes[0] + sizes[1] + sizes[2] + sizes[3];
  if (sizes.length !== 4 || sizes[0] !== n * 6 || sizes[1] !== n * 2
    || expectedTotal !== stream.byteLength) {
    throw new Error(`Tropical Island surface size mismatch (sections ${sizes.join('+')} = ${expectedTotal}, stream ${stream.byteLength})`);
  }
  const position = new Float32Array(n * 3);
  for (let i = 0; i < position.length; i += 1) {
    const axis = i % 3;
    position[i] = meta.origin[axis] + (view.getUint16(i * 2, true) / 65535) * meta.extent[axis];
  }
  const normal = new Float32Array(n * 3);
  let nc = sizes[0];
  for (let i = 0; i < n; i += 1) {
    const bx = stream[nc++], by = stream[nc++];
    // Reserve one duplicate -Z corner for exact source zero normals.
    if (bx === 0 && by === 0) continue;
    let x = bx / 127.5 - 1, y = by / 127.5 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const ox = x;
      x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
      y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
    }
    const inverseLength = 1 / Math.hypot(x, y, z);
    normal[i * 3] = x * inverseLength;
    normal[i * 3 + 1] = y * inverseLength;
    normal[i * 3 + 2] = z * inverseLength;
  }
  // Subarray, not slice copy: same backing buffer, no extra allocation.
  const colourBytes = stream.subarray(nc, nc + sizes[2]);
  const colour = new Float32Array(n * 3);
  for (let i = 0; i < colour.length; i += 1) {
    const c = stream[nc + i] / 255;
    colour[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  nc += sizes[2];
  const index = new Uint32Array(meta.triangleCount * 3);
  let previous = 0;
  for (let i = 0; i < index.length; i += 1) {
    let value = 0;
    let multiplier = 1;
    for (let count = 0; ; count += 1) {
      if (nc >= stream.byteLength || count > 4) throw new Error('Tropical Island index varint runaway');
      const byte = stream[nc++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) break;
      multiplier *= 128;
    }
    previous += value % 2 === 0 ? value / 2 : -(value + 1) / 2;
    if (previous < 0 || previous >= n) throw new Error(`Tropical Island index out of range (${previous} >= ${n})`);
    index[i] = previous;
  }
  if (nc !== stream.byteLength) throw new Error(`Tropical Island index section consumed ${nc} of ${stream.byteLength} bytes`);
  return { position, normal, colour, colourBytes, index };
}

/** Build a measured Group for a single role. Materials and geometry are fresh per call. */
export function buildMeasuredSurface(
  meta: SurfaceMeta,
  stream: Uint8Array,
  evidence: SurfaceEvidence,
  groupName: string,
): THREE.Group {
  const data = decodeSurface(meta, stream);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colour, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Use the measured map medians, not the (constant) material factors.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: meta.medianRoughness,
    metalness: meta.medianMetalness,
    side: meta.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    opacity: meta.baseColorFactor[3],
    transparent: meta.alphaMode === 'BLEND',
    alphaTest: meta.alphaMode === 'MASK' ? meta.alphaCutoff : 0,
    depthWrite: meta.alphaMode !== 'BLEND',
  });
  if (meta.emissiveFactor[0] || meta.emissiveFactor[1] || meta.emissiveFactor[2]) {
    material.emissive = new THREE.Color(meta.emissiveFactor[0], meta.emissiveFactor[1], meta.emissiveFactor[2]);
  }
  material.name = meta.materialName ?? groupName;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = meta.meshName ?? groupName;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Build the original source node chain INSIDE an outer mutable identity group.
  // Main's normaliseAsset / placement mutates the outer root.position and
  // root.scale; the inner groups are locked to the measured source transforms.
  const outer = new THREE.Group();
  outer.name = groupName;
  outer.matrixAutoUpdate = true;
  let parent: THREE.Object3D = outer;
  for (const nd of meta.nodeChain) {
    const g = new THREE.Group();
    g.name = nd.name ?? '';
    if (nd.matrix) {
      g.matrix.fromArray(nd.matrix);
      g.matrixAutoUpdate = false;
    }
    parent.add(g);
    parent = g;
  }
  parent.add(mesh);
  // Install evidence non-enumerably so glTF exporters / Object3D.toJSON() do not
  // bake the per-vertex data into GLB export extras.
  Object.defineProperty(geometry.userData, 'surfaceEvidence', {
    value: evidence,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(outer.userData, 'sourceIdentity', {
    value: {
      meshNodeName: meta.meshNodeName,
      meshName: meta.meshName,
      materialName: meta.materialName,
      sourceSha256: meta.sourceSha256,
      sourceBytes: meta.sourceBytes,
      route: meta.route,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return outer;
}
