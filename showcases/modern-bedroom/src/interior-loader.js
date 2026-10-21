// Asset loading for the interior viewer: every asset of the optimised runtime set (public/assets/interior-runtime, written
// by `npm run optimize:assets`) is fetched concurrently with one aggregated byte progress, and the runtime GLB is parsed with
// the decoders its own header asks for (Meshopt geometry, KTX2/Basis textures; a plain GLB loads without either).
// There is no EXR anywhere on this path: atlases are UASTC-HDR KTX2 (already oriented and rim-repaired offline), the CPU-side
// lightmap lookups come from the precomputed per-vertex samples, the probe and sky are Radiance .hdr.
//
//   const assets  = createAssetLoader({ renderer, onProgress });
//   const gltf    = await assets.loadGltf(manifest.model);
//   const probe   = await assets.loadHdr(manifest.environment);        // DataTexture (half float), as HDRLoader.loadAsync returned it
//   const atlas   = await assets.loadLightmap(atlas.url);              // KTX2 CompressedTexture (BC6H / ASTC HDR / RGBA16F fallback)
//   const samples = await assets.loadLightmapSamples(manifest.lightmapSamples);   // see createLightmapSamples
//   ...
//   assets.release();                                                   // after all loads settled (ends the Basis transcoder workers)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createLightmapSamples } from './interior-lightmaps.js';
import { fetchBytes } from './fetch-bytes.js';

const PROGRESS_INTERVAL_MS = 60;
const QUANTIZED_ATTRIBUTES = ['position', 'normal', 'tangent', 'uv', 'uv1', 'color'];

// One macrotask hop per call (MessageChannel: no 4 ms timer clamping), so queued work interleaves with input and paint.
const hop = new MessageChannel();
const hopWaiting = [];
hop.port1.onmessage = () => hopWaiting.shift()?.();
export function yieldTask() {
  return new Promise(resolve => { hopWaiting.push(resolve); hop.port2.postMessage(0); });
}

// A paint has happened since the call (progress bars, first frames); resolves at once in a hidden tab.
export function nextPaint() {
  return document.hidden ? Promise.resolve() : new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
}

// GLTFLoader builds all 365 meshes in a single task; one macrotask per mesh keeps every task short.
function yieldPerMesh(parser) {
  return { name: 'LoadOpt_YieldPerMesh', loadMesh: index => yieldTask().then(() => parser.loadMesh(index)) };
}

// Uploads textures to the GPU one at a time and yields to the page whenever a slice used more than `budgetMs`, so the
// multi-hundred-megabyte atlas/PBR uploads never form one long task. Textures can be added while earlier ones upload
// (e.g. an atlas the moment it is transcoded); `idle()` resolves when the queue is empty.
export function createTextureUploader(renderer, { budgetMs = 12, shouldStop = () => false } = {}) {
  const queue = [];
  let running = null;
  let count = 0;
  let busyMs = 0;
  let failure = null;
  async function run() {
    let sliceStart = performance.now();
    while (queue.length) {
      if (shouldStop()) { queue.length = 0; return; }
      const started = performance.now();
      try { renderer.initTexture(queue.shift()); } catch (error) { failure ??= error; queue.length = 0; return; }
      busyMs += performance.now() - started;
      count++;
      if (performance.now() - sliceStart > budgetMs) {
        await nextPaint();
        sliceStart = performance.now();
      }
    }
  }
  return {
    add(...textures) {
      queue.push(...textures);
      running ??= run().finally(() => { running = null; if (queue.length) this.add(); });
      return running;
    },
    // Resolves when the queue is empty; rejects with the first upload error.
    async idle() { await running; if (failure) throw failure; },
    get uploaded() { return count; },
    get busyMs() { return Math.round(busyMs); },
  };
}

// The JSON chunk of a GLB names the extensions it needs; read it to load only the decoders that are used.
function glbExtensionFlags(buffer) {
  const flags = { meshopt: false, ktx2: false };
  if (buffer.byteLength < 20) return flags;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return flags;
  const json = new TextDecoder().decode(new Uint8Array(buffer, 20, Math.min(view.getUint32(12, true), buffer.byteLength - 20)));
  flags.meshopt = json.includes('EXT_meshopt_compression');
  flags.ktx2 = json.includes('KHR_texture_basisu');
  return flags;
}

// Quantized (KHR_mesh_quantization / meshopt filter) attributes stay integer in three.js. The cloth, curtain and palette code
// reads `attribute.array` as float coordinates, so hand it float arrays; the decoded values are identical.
function dequantizeGeometries(root) {
  const seen = new Set();
  let converted = 0;
  root.traverse(object => {
    const geometry = object.geometry;
    if (!geometry || seen.has(geometry)) return;
    seen.add(geometry);
    for (const name of QUANTIZED_ATTRIBUTES) {
      const attribute = geometry.getAttribute(name);
      if (!attribute || attribute.array instanceof Float32Array) continue;
      const { count, itemSize } = attribute;
      const array = new Float32Array(count * itemSize);
      for (let i = 0; i < count; i++) {
        array[i * itemSize] = attribute.getX(i);
        if (itemSize > 1) array[i * itemSize + 1] = attribute.getY(i);
        if (itemSize > 2) array[i * itemSize + 2] = attribute.getZ(i);
        if (itemSize > 3) array[i * itemSize + 3] = attribute.getW(i);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize, false));
      converted++;
    }
  });
  return converted;
}

export function createAssetLoader({ renderer = null, onProgress = null, baseUrl = import.meta.env.BASE_URL } = {}) {
  const abort = new AbortController();
  const files = new Map();
  const stats = { bytes: 0, decodeMs: {}, fetchMs: {}, dequantized: 0, decoders: [], events: [] };
  const mark = (what, url) => stats.events.push([Math.round(performance.now()), what, url.split('/').pop()]);
  let lastEmit = 0;
  let lastFraction = 0;
  let timer = 0;
  let ktx2Promise = null;
  let ktx2Loader = null;
  // One KTX2Loader (and Basis transcoder worker pool) shared by the GLB's textures and the lightmap atlases.
  function getKtx2Loader() {
    if (!renderer) return Promise.reject(new Error('KTX2 textures need the renderer for GPU format detection.'));
    ktx2Promise ??= import('three/addons/loaders/KTX2Loader.js').then(({ KTX2Loader }) => {
      ktx2Loader = new KTX2Loader().setTranscoderPath(`${baseUrl}vendor/basis/`).detectSupport(renderer);
      return ktx2Loader;
    });
    return ktx2Promise;
  }
  let released = false;

  function emit(force) {
    if (!onProgress) return;
    const now = performance.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) {
      if (!timer) timer = setTimeout(() => { timer = 0; emit(true); }, PROGRESS_INTERVAL_MS);
      return;
    }
    clearTimeout(timer);
    timer = 0;
    lastEmit = now;
    let loaded = 0, total = 0, decoded = 0, done = 0;
    for (const file of files.values()) {
      const size = file.total || file.loaded;
      loaded += file.loaded;
      total += size;
      if (file.done) { decoded += size; done++; }
    }
    // Each byte counts twice: once when it arrives, once when its asset is decoded. Never goes backwards while totals
    // of late-starting requests are still being announced.
    lastFraction = Math.max(lastFraction, total ? (loaded + decoded) / (2 * total) : 0);
    onProgress({ loaded, total, decoded, fraction: lastFraction, files: files.size, filesDone: done });
  }

  function track(url) {
    const file = { url, loaded: 0, total: 0, done: false };
    files.set(url, file);
    return file;
  }

  async function fetchTracked(url) {
    if (released) throw new Error('Asset loader was released.');
    const file = files.get(url) ?? track(url);
    const started = performance.now();
    mark('fetch-start', url);
    const buffer = await fetchBytes(url, {
      signal: abort.signal,
      onProgress: (loaded, total) => { file.loaded = loaded; if (total) file.total = total; emit(false); },
    });
    file.loaded = buffer.byteLength;
    file.total = buffer.byteLength;
    stats.bytes += buffer.byteLength;
    stats.fetchMs[url] = Math.round(performance.now() - started);
    mark('fetch-end', url);
    emit(false);
    return buffer;
  }

  function finish(url) {
    const file = files.get(url);
    if (file) file.done = true;
    emit(true);
  }

  return {
    stats,
    // A Radiance .hdr (environment probe, sky) as a half-float DataTexture; the state HDRLoader.load leaves behind.
    async loadHdr(url) {
      if (!/\.hdr(\?|$)/i.test(url)) throw new Error(`${url} is not a Radiance .hdr image; re-run npm run optimize:assets.`);
      const buffer = await fetchTracked(url);
      const started = performance.now();
      const decoded = new HDRLoader().parse(buffer);
      const texture = new THREE.DataTexture(decoded.data, decoded.width, decoded.height, THREE.RGBAFormat, decoded.type);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.flipY = true;
      texture.needsUpdate = true;
      stats.decodeMs[url] = Math.round(performance.now() - started);
      mark('hdr-decoded', url);
      finish(url);
      return texture;
    },
    // A lightmap atlas: UASTC-HDR KTX2, rows already oriented for glTF UV1 and rims already repaired by the optimiser. Transcodes to
    // BC6H / ASTC HDR where the GPU has either, else to RGBA16F (three's KTX2Loader picks). Sampler state matches the old EXR atlases.
    async loadLightmap(url) {
      const [buffer, loader] = await Promise.all([fetchTracked(url), getKtx2Loader()]);
      const started = performance.now();
      const texture = await new Promise((resolve, reject) => loader.parse(buffer, resolve, reject));
      texture.channel = 1;
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      stats.decodeMs[url] = Math.round(performance.now() - started);
      mark('ktx2-transcoded', url);
      finish(url);
      return texture;
    },
    // The precomputed per-vertex lightmap texels every CPU-side lookup reads (manifest.lightmapSamples: { url, index }).
    async loadLightmapSamples(descriptor) {
      if (!descriptor?.url || !descriptor?.index) throw new Error('The manifest has no lightmapSamples; re-run npm run optimize:assets.');
      const [bin, indexBuffer] = await Promise.all([fetchTracked(descriptor.url), fetchTracked(descriptor.index)]);
      const samples = createLightmapSamples(JSON.parse(new TextDecoder().decode(indexBuffer)), bin);
      mark('samples-ready', descriptor.url);
      finish(descriptor.url);
      finish(descriptor.index);
      return samples;
    },
    async loadGltf(url) {
      const buffer = await fetchTracked(url);
      const started = performance.now();
      const flags = glbExtensionFlags(buffer);
      const loader = new GLTFLoader();
      loader.register(yieldPerMesh);
      if (flags.meshopt) {
        const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
        loader.setMeshoptDecoder(MeshoptDecoder);
        stats.decoders.push('meshopt');
      }
      if (flags.ktx2) {
        loader.setKTX2Loader(await getKtx2Loader());
        stats.decoders.push('ktx2');
      }
      const gltf = await loader.parseAsync(buffer, url.slice(0, url.lastIndexOf('/') + 1));
      stats.dequantized = dequantizeGeometries(gltf.scene);
      stats.decodeMs[url] = Math.round(performance.now() - started);
      mark('gltf-parsed', url);
      finish(url);
      return gltf;
    },
    // Call once every asset settled (success or failure): ends the Basis transcoder workers.
    release() {
      released = true;
      clearTimeout(timer);
      ktx2Loader?.dispose();
      ktx2Loader = null;
    },
    // Disposal while loads are still in flight: aborts the network reads, then releases.
    abort() {
      abort.abort();
      this.release();
    },
  };
}
