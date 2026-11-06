import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import basisJS from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisWASM from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import { validateManifest } from './interior-manifest.js';
import { prepareTier, commitTier, preparedTextures } from './interior-tier-publication.js';

let decoderUsers = 0;
const abortError = () => new DOMException('Asset session was cancelled.', 'AbortError');
const textureSlots = material => Object.keys(material).filter(key => material[key]?.isTexture);
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
function rankOf(priority) {
  const rank = PRIORITIES.indexOf(priority);
  if (rank < 0) throw new Error(`Unknown streaming priority ${String(priority)}; expected P0..P3.`);
  return rank;
}

// Data arrays are already in the GPU upload format, including transcode fallbacks.
export function textureByteLength(texture) {
  const image = texture.image;
  const levels = texture.mipmaps?.length ? texture.mipmaps : Array.isArray(image) ? image : [image];
  let bytes = 0;
  for (const level of levels) {
    if (level?.data) bytes += level.data.byteLength;
    else if (level?.width && level?.height) {
      const channels = texture.format === THREE.RedFormat ? 1 : texture.format === THREE.RGFormat ? 2 : 4;
      const scalar = texture.type === THREE.FloatType ? 4 : texture.type === THREE.HalfFloatType ? 2 : 1;
      bytes += level.width * level.height * channels * scalar;
    }
  }
  const size = Array.isArray(image) ? image[0] : image;
  if (texture.generateMipmaps && !texture.mipmaps?.length && size?.width) {
    let w = size.width, h = size.height;
    const perPixel = bytes / (w * h);
    while (w > 1 || h > 1) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); bytes += w * h * perPixel; }
  }
  return bytes;
}

export class RuntimeAssetLoader {
  constructor({ manifest, renderer, baseUrl = document.baseURI, benchmark = false, fetchLimit = 6,
    onProgress = () => {}, onError = () => {}, onFetchedAsset = () => {} }) {
    validateManifest(manifest);
    if (!Number.isInteger(fetchLimit) || fetchLimit < 1) throw new RangeError('fetchLimit must be a positive integer.');
    this.manifest = manifest;
    this.renderer = renderer;
    this.baseUrl = baseUrl;
    this.benchmark = benchmark;
    this.fetchLimit = fetchLimit;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onFetchedAsset = onFetchedAsset;
    this.fetchedAssets = [];
    this.ledger = new Map();
    // Shared in-flight/settled work: key -> { promise, value, controller, waiters, settled, rank, meta }.
    this.requests = new Map();
    this.textureCache = new Map();
    this.roomCache = new Map();
    this.highCache = new Map();
    this.lightmapCache = new Map();
    this.probeCache = new Map();
    this.backgroundCache = new Map();
    this.jobs = new Map();
    this.textureUsers = new Map();
    this.tierApplications = new Map();
    this.queue = [];
    this.activeFetches = 0;
    this.sequence = 0;
    this.loadedRooms = new Set();
    this.readyRooms = new Set();
    this.textures = new Set();
    this.geometries = new Set();
    this.materials = new Set();
    this.pending = new Set();
    this.blobs = new Set();
    this.abort = new AbortController();
    this.disposed = false;
    this.manager = new THREE.LoadingManager();
    this.ktx = new KTX2Loader(this.manager).setWorkerLimit(2).detectSupport(renderer);
    this.decoderReady = null;
    if (decoderUsers++ === 0) MeshoptDecoder.useWorkers(2);
  }

  room(id) {
    const room = this.manifest.house.rooms.find(item => item.id === id);
    if (!room) throw new Error(`Unknown room: ${id}`);
    return room;
  }

  check() { if (this.disposed) throw abortError(); }

  assetUrl(path) {
    // Authored /assets paths are deployment-relative; decoder imports already carry
    // the bundler's base and must not be prefixed a second time.
    return new URL(path.startsWith('/assets/') ? path.slice(1) : path, this.baseUrl).href;
  }

  /**
   * Shared, reference-counted work. Every caller waits on the same promise; when the last
   * waiting caller aborts, the underlying work receives an abort and is forgotten so a later
   * request starts fresh. A caller that aborts rejects immediately.
   */
  share(map, key, start, signal, { rank = 0, meta = {} } = {}) {
    this.check();
    if (signal?.aborted) return Promise.reject(abortError());
    let entry = map.get(key);
    if (entry) entry.rank = Math.min(entry.rank, rank);
    else {
      const controller = new AbortController();
      const abortAll = () => controller.abort();
      this.abort.signal.addEventListener('abort', abortAll, { once: true });
      entry = { controller, waiters: 0, settled: false, rank, meta, value: undefined, promise: null };
      const current = entry;
      current.promise = Promise.resolve().then(() => start(controller.signal, current));
      const finish = () => { current.settled = true; this.abort.signal.removeEventListener('abort', abortAll); };
      current.promise.then(value => { current.value = value; finish(); }, () => {
        finish();
        if (map.get(key) === current) map.delete(key);
      });
      map.set(key, current);
    }
    const shared = entry;
    shared.waiters++;
    return new Promise((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal?.removeEventListener('abort', onAbort);
        if (--shared.waiters === 0 && !shared.settled) {
          shared.controller.abort();
          if (map.get(key) === shared) map.delete(key);
        }
      };
      const onAbort = () => { leave(); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(value => { if (!left) { leave(); resolve(value); } },
        error => { if (!left) { leave(); reject(error); } });
    });
  }

  // Priority queue of network requests: lowest priority rank first, then request order.
  slot(entry, meta, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.activeFetches < this.fetchLimit && !this.queue.length) { this.activeFetches++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const item = { entry, meta, seq: this.sequence++, resolve };
      const abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      item.release = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
    });
  }

  pump() {
    while (this.activeFetches < this.fetchLimit && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i], b = this.queue[best];
        if (a.entry.rank < b.entry.rank || (a.entry.rank === b.entry.rank && a.seq < b.seq)) best = i;
      }
      const [item] = this.queue.splice(best, 1);
      item.release();
      this.activeFetches++;
      item.resolve();
    }
  }

  releaseSlot() { this.activeFetches = Math.max(0, this.activeFetches - 1); this.pump(); }

  /** Raise or lower the priority of every still-queued request that belongs to (room, tier). */
  reprioritize(roomId, tier, priority) {
    const rank = rankOf(priority);
    const job = this.jobs.get(`${roomId}:${tier}`);
    if (job) job.priority = priority;
    for (const entry of this.requests.values()) {
      if (!entry.settled && entry.meta.roomId === roomId && entry.meta.tier === tier) entry.rank = rank;
    }
    for (const item of this.queue) {
      if (item.meta.roomId === roomId && item.meta.tier === tier) item.entry.rank = rank;
    }
  }

  priorityFor(roomId, tier) { return this.jobs.get(`${roomId}:${tier}`)?.priority ?? (tier === 'standard' ? 'P0' : 'P1'); }

  fetchBytes(path, meta = {}, signal) {
    this.check();
    const url = this.assetUrl(path);
    const rank = rankOf(meta.priority ?? 'P0');
    return this.share(this.requests, url, (jobSignal, entry) => this.download(url, meta, jobSignal, entry), signal, { rank, meta });
  }

  async download(url, meta, signal, entry) {
    await this.slot(entry, meta, signal);
    try {
      this.check();
      const priority = PRIORITIES[entry.rank];
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Could not load ${url} (${response.status}). Choose Retry load.`);
      const data = await response.arrayBuffer();
      this.check();
      const record = { url, bytes: data.byteLength, ...meta, priority };
      if (this.benchmark) {
        const hash = await crypto.subtle.digest('SHA-256', data);
        record.sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      this.check();
      this.fetchedAssets.push(record);
      this.onFetchedAsset(record);
      this.onProgress(record);
      return data;
    } finally { this.releaseSlot(); }
  }

  async initDecoder(meta) {
    if (!this.decoderReady) this.decoderReady = (async () => {
      const files = await Promise.all([this.fetchBytes(basisJS, { ...meta, role: 'decoder' }), this.fetchBytes(basisWASM, { ...meta, role: 'decoder' })]);
      this.check();
      const urls = files.map((bytes, index) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: index ? 'application/wasm' : 'text/javascript' }));
        this.blobs.add(url);
        return url;
      });
      this.manager.setURLModifier(url => url.endsWith('basis_transcoder.js') ? urls[0] : url.endsWith('basis_transcoder.wasm') ? urls[1] : url);
      await this.ktx.init();
      this.check();
    })();
    return this.decoderReady;
  }

  ownTexture(texture, metadata) {
    this.textures.add(texture);
    texture.userData = { ...texture.userData, ...metadata };
    this.ledger.set(texture.uuid, { id: texture.uuid, kind: 'texture', ...metadata,
      format: texture.format, type: texture.type, mipLevels: texture.mipmaps?.length || 1,
      bytes: textureByteLength(texture), uploaded: false });
    const prior = texture.onUpdate;
    texture.onUpdate = value => {
      prior?.(value);
      const record = this.ledger.get(texture.uuid);
      if (record) { record.uploaded = true; record.bytes = textureByteLength(texture); }
    };
    texture.addEventListener('dispose', () => {
      const record = this.ledger.get(texture.uuid);
      if (record) record.uploaded = false;
    });
    return texture;
  }

  addUser(key, roomId) {
    if (roomId === undefined) return;
    if (!this.textureUsers.has(key)) this.textureUsers.set(key, new Set());
    this.textureUsers.get(key).add(roomId);
  }

  async texture(textureId, tier, meta, signal) {
    const definition = this.manifest.textures[textureId];
    if (!definition) throw new Error(`Unknown textureId ${textureId}; re-export and encode the room.`);
    const key = `${textureId}:${tier}`;
    const texture = await this.share(this.textureCache, key, async jobSignal => {
      try {
        await this.initDecoder(meta);
        const data = await this.fetchBytes(definition[tier], { ...meta, role: definition.role, textureId }, jobSignal);
        this.check();
        if (jobSignal.aborted) throw abortError();
        // KTX2 transfers the buffer to its worker; retain fetched bodies for shared URLs.
        const parsed = await new Promise((resolve, reject) => this.ktx.parse(data.slice(0), resolve, reject));
        if (this.disposed || jobSignal.aborted) { parsed.dispose(); throw abortError(); }
        parsed.name = textureId;
        parsed.flipY = false;
        parsed.colorSpace = definition.role === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        return this.ownTexture(parsed, { textureId, tier, role: definition.role, url: definition[tier] });
      } catch (error) {
        // A successful HTTP body can still be corrupt. A retry must refetch it.
        if (error.name !== 'AbortError') this.requests.delete(this.assetUrl(definition[tier]));
        throw error;
      }
    }, signal, { rank: rankOf(meta.priority ?? 'P0'), meta });
    this.addUser(key, meta.roomId);
    return texture;
  }

  /** Drop one room's claim on a cached texture; dispose it when nobody uses it any more. */
  releaseTexture(textureId, tier, roomId) {
    const key = `${textureId}:${tier}`;
    const users = this.textureUsers.get(key);
    users?.delete(roomId);
    if (users?.size) return 0;
    this.textureUsers.delete(key);
    const entry = this.textureCache.get(key);
    this.textureCache.delete(key);
    this.requests.delete(this.assetUrl(this.manifest.textures[textureId][tier]));
    const texture = entry?.value;
    if (!texture) { entry?.controller.abort(); return 0; }
    const bytes = this.ledger.get(texture.uuid)?.bytes ?? 0;
    texture.dispose();
    this.textures.delete(texture);
    this.ledger.delete(texture.uuid);
    return bytes;
  }

  run(work, signal, context) {
    if (signal?.aborted || this.disposed) return Promise.reject(abortError());
    const operation = Promise.resolve().then(() => work(signal));
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {});
    const cancelled = new Promise((_, reject) => {
      const listener = () => reject(abortError());
      this.abort.signal.addEventListener('abort', listener, { once: true });
      signal?.addEventListener('abort', listener, { once: true });
      operation.finally(() => {
        this.abort.signal.removeEventListener('abort', listener);
        signal?.removeEventListener('abort', listener);
      }).catch(() => {});
    });
    cancelled.catch(() => {});
    return Promise.race([operation, cancelled]).catch(error => {
      if (error.name !== 'AbortError') {
        this.onError(error, context);
        // The priority is read now: a request promoted to P0 while in flight fails the session.
        if (context.priority === 'P0') this.dispose();
      }
      throw error;
    });
  }

  loadLightmaps(roomId, { signal } = {}) {
    return this.run(runSignal => this.getLightmaps(roomId, runSignal), signal, { roomId, priority: 'P0' });
  }

  getLightmaps(roomId, signal) {
    const priority = this.priorityFor(roomId, 'standard');
    return this.share(this.lightmapCache, roomId, async jobSignal => {
      const results = await Promise.allSettled(this.room(roomId).lightmaps.map(async atlas => {
        const bytes = await this.fetchBytes(atlas.url, { roomId, tier: 'standard', priority, role: 'lightmap' }, jobSignal);
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }),
          { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
        if (this.disposed || jobSignal.aborted) { image.close(); throw abortError(); }
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.NoColorSpace;
        texture.flipY = false;
        texture.premultiplyAlpha = false;
        texture.channel = 1;
        // RGBM interpolation must happen AFTER four independent texel decodes in the shader.
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        this.ownTexture(texture, { roomId, role: 'lightmap', url: atlas.url });
        return [atlas.id, { ...atlas, texture }];
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return new Map(results.map(result => result.value));
    }, signal, { rank: rankOf(priority), meta: { roomId, tier: 'standard' } });
  }

  loadProbe(roomId, { signal } = {}) {
    return this.run(runSignal => this.getProbe(roomId, runSignal), signal, { roomId, priority: 'P0' });
  }

  getProbe(roomId, signal) {
    const priority = this.priorityFor(roomId, 'standard');
    return this.share(this.probeCache, roomId, jobSignal =>
      this.hdr(this.room(roomId).probe.url, { roomId, tier: 'standard', priority, role: 'probe' }, jobSignal),
    signal, { rank: rankOf(priority), meta: { roomId, tier: 'standard' } });
  }

  async hdr(url, meta, signal) {
    const bytes = await this.fetchBytes(url, meta, signal);
    this.check();
    const image = new HDRLoader().setDataType(THREE.HalfFloatType).parse(bytes);
    if (!image) throw new Error(`Invalid RGBE image: ${url}`);
    const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = true;
    texture.needsUpdate = true;
    return this.ownTexture(texture, { ...meta, url });
  }

  loadBackground({ signal } = {}) {
    return this.run(runSignal => {
      if (!this.manifest.background) return null;
      return this.share(this.backgroundCache, 'background', jobSignal =>
        this.hdr(this.manifest.background.url, { priority: 'P0', role: 'background' }, jobSignal), runSignal, { rank: 0, meta: {} });
    }, signal, { priority: 'P0' });
  }

  /**
   * tier "standard" loads geometry, material textures, lightmaps and the probe for one room;
   * tier "high" adds that room's high texture set. `priority` is P0..P3 and can be changed
   * while the request is in flight with reprioritize(). Aborting `signal` cancels this request
   * only; work that another room still awaits (shared textures) keeps running.
   */
  loadRoom(roomId, { tier = 'standard', signal, priority = tier === 'standard' ? 'P0' : 'P1' } = {}) {
    const rank = rankOf(priority);
    const context = { roomId, tier, priority };
    const jobKey = `${roomId}:${tier}`;
    this.jobs.set(jobKey, context);
    const operation = this.run(async runSignal => {
      this.room(roomId);
      if (!['standard', 'high'].includes(tier)) throw new Error(`Unknown texture tier ${tier}`);
      if (tier === 'high') {
        if (!this.readyRooms.has(roomId)) throw new Error(`Room ${roomId} must render its standard P0 frame before loading high textures.`);
        const standard = await this.roomCache.get(roomId).promise;
        return this.share(this.highCache, roomId, jobSignal => this.loadHigh(roomId, standard, jobSignal, context),
          runSignal, { rank, meta: { roomId, tier } });
      }
      return this.share(this.roomCache, roomId, jobSignal => this.loadStandard(roomId, jobSignal, context),
        runSignal, { rank, meta: { roomId, tier } });
    }, signal, context);
    const settle = () => { if (this.jobs.get(jobKey) === context) this.jobs.delete(jobKey); };
    operation.then(settle, settle);
    return operation;
  }

  async loadHigh(roomId, standard, signal, context) {
    const tier = 'high';
    const results = await Promise.allSettled(standard.textureIds.map(async id =>
      [id, await this.texture(id, tier, { roomId, tier, priority: context.priority }, signal)]));
    const failure = results.find(result => result.status === 'rejected');
    if (failure || signal.aborted) {
      for (const result of results) if (result.status === 'fulfilled') this.releaseTexture(result.value[0], tier, roomId);
      throw failure?.reason ?? abortError();
    }
    this.check();
    return { ...standard, tier, textures: new Map(results.map(result => result.value)) };
  }

  async loadStandard(roomId, signal, context) {
    const room = this.room(roomId);
    const meta = { roomId, tier: 'standard', priority: context.priority };
    const ownedGeometries = new Set(), ownedMaterials = new Set();
    const own = (geometry, material) => {
      if (geometry) { this.geometries.add(geometry); ownedGeometries.add(geometry); }
      if (material) { this.materials.add(material); ownedMaterials.add(material); }
    };
    const gltfTask = (async () => {
      const bytes = await this.fetchBytes(room.geometry, { ...meta, role: 'geometry' }, signal);
      this.check();
      const ids = new Set();
      let parserRef;
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx);
      // Override the shared image-binding entry point, not a plugin that loses to KHR_texture_basisu.
      loader.register(parser => {
        parserRef = parser;
        parser.loadTextureImage = async (textureIndex, sourceIndex) => {
          const image = parser.json.images[sourceIndex];
          if (!image?.name || !image.uri || image.bufferView !== undefined) throw new Error('Runtime images require external KTX2 URLs and stable image.name textureIds.');
          ids.add(image.name);
          const texture = await this.texture(image.name, 'standard', { ...meta, priority: this.priorityFor(roomId, 'standard') }, signal);
          const sampler = parser.json.samplers?.[parser.json.textures[textureIndex].sampler] ?? {};
          const signature = JSON.stringify(sampler);
          if (texture.userData.samplerSignature !== undefined && texture.userData.samplerSignature !== signature) throw new Error(`Texture ${image.name} uses inconsistent samplers across rooms.`);
          texture.userData.samplerSignature = signature;
          const filters = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter,
            9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
          const wraps = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
          texture.magFilter = filters[sampler.magFilter] ?? THREE.LinearFilter;
          texture.minFilter = filters[sampler.minFilter] ?? THREE.LinearMipmapLinearFilter;
          texture.wrapS = wraps[sampler.wrapS] ?? THREE.RepeatWrapping;
          texture.wrapT = wraps[sampler.wrapT] ?? THREE.RepeatWrapping;
          parser.associations.set(texture, { textures: textureIndex });
          return texture;
        };
        return { name: 'INTERIOR_texture_tiers', beforeRoot: () => {
          if (parser.json.buffers?.some(buffer => buffer.uri)) throw new Error('Room GLB must embed geometry buffers.');
        } };
      });
      let gltf, parseError;
      try { gltf = await loader.parseAsync(bytes, new URL('.', this.assetUrl(room.geometry)).href); }
      catch (error) { parseError = error; }
      // GLTF can reject before parallel primitives finish. Drain and own successful
      // dependencies, including those not attached to a scene, before failure cleanup.
      const dependencies = parserRef ? await Promise.allSettled(
        (parserRef.json.meshes ?? []).map((_, index) => parserRef.getDependency('mesh', index))) : [];
      if (gltf) dependencies.push({ status: 'fulfilled', value: gltf.scene });
      for (const dependency of dependencies) {
        if (dependency.status !== 'fulfilled') continue;
        dependency.value.traverse(node => {
          if (!node.isMesh) return;
          own(node.geometry);
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            own(null, material);
            for (const key of textureSlots(material)) if (!this.textures.has(material[key])) this.ownTexture(material[key], material[key].userData);
          }
        });
      }
      if (parseError && parserRef) {
        const partial = await Promise.allSettled([
          ...(parserRef.json.materials ?? []).map((_, index) => parserRef.getDependency('material', index)),
          ...Object.values(parserRef.primitiveCache).map(entry => entry.promise),
        ]);
        for (const result of partial) {
          if (result.status !== 'fulfilled') continue;
          const resource = result.value;
          if (resource.isBufferGeometry) own(resource);
          if (resource.isMaterial) {
            own(null, resource);
            for (const key of textureSlots(resource)) if (!this.textures.has(resource[key])) this.ownTexture(resource[key], resource[key].userData);
          }
        }
      }
      if (parseError) throw parseError;
      const textures = await gltf.parser.getDependencies('texture');
      if (textures.some(texture => !texture)) throw new Error(`Room ${roomId} has missing textures; retry or re-encode.`);
      this.check();
      return { gltf, scene: gltf.scene, textureIds: [...ids], textures: new Map(textures.map(texture => [texture.userData.textureId, texture])) };
    })();
    // Settle all branches before releasing resources, including late decoder outputs.
    const results = await Promise.allSettled([gltfTask, this.getLightmaps(roomId, signal), this.getProbe(roomId, signal)]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure || signal.aborted) {
      // A failed or cancelled room must not keep its parsed geometry and materials resident.
      for (const geometry of ownedGeometries) { geometry.dispose(); this.geometries.delete(geometry); }
      for (const material of ownedMaterials) { material.dispose(); this.materials.delete(material); }
      throw failure?.reason ?? abortError();
    }
    this.check();
    this.loadedRooms.add(roomId);
    return { ...results[0].value, roomId, tier: 'standard', lightmaps: results[1].value, probe: results[2].value,
      ledger: this.ledger, fetchedAssets: this.fetchedAssets };
  }

  markReady(roomId) {
    this.check();
    if (!this.loadedRooms.has(roomId)) throw new Error(`Room ${roomId} has not completed its standard assets.`);
    this.readyRooms.add(roomId);
  }

  /**
   * Prepare a room's high tier without exposing it: the new textures are created and owned, but
   * no material slot is changed yet. The caller uploads the prepared textures and then commits
   * the tier with commitTier(), so no frame ever renders a texture that was not uploaded.
   *
   * @param {THREE.Object3D} root the room root
   * @param {object} result the loaded high tier
   * @returns {{replacements: Map, prepared: {material: object, key: string, old: object, clone: object}[]}}
   */
  prepareTier(root, result) {
    this.check();
    const prepared = prepareTier(root, result.textures, result.tier);
    for (const texture of preparedTextures(prepared)) this.ownTexture(texture, texture.userData);
    return prepared;
  }

  /** The textures a prepared tier would install. */
  preparedTextures(prepared) {
    return preparedTextures(prepared);
  }

  /**
   * Install a prepared tier: every material slot is swapped in one synchronous step, so a frame
   * never sees a half-swapped room.
   */
  commitTier(roomId, prepared) {
    this.check();
    const count = commitTier(prepared);
    const applied = this.tierApplications.get(roomId) ?? [];
    for (const entry of prepared.prepared) applied.push(entry);
    if (applied.length) this.tierApplications.set(roomId, applied);
    return count;
  }

  /**
   * Release a prepared tier that was never committed: its uploaded clones and the loaded high
   * textures they were cloned from. The sources are only released while they are still this
   * load's, so a tier that was loaded again since is left alone.
   */
  discardPreparedTier(roomId, prepared, result) {
    for (const texture of preparedTextures(prepared)) {
      this.textures.delete(texture);
      this.ledger.delete(texture.uuid);
      texture.dispose();
    }
    this.releaseHighSources(roomId, result);
  }

  /** Release a loaded high tier's source textures when they are still the cached ones. */
  releaseHighSources(roomId, result) {
    if (!result) return;
    for (const [id, source] of result.textures) {
      if (this.textureCache.get(`${id}:high`)?.value === source) this.releaseTexture(id, 'high', roomId);
    }
    if (this.highCache.get(roomId)?.value === result) this.highCache.delete(roomId);
  }

  applyTier(root, result) {
    const prepared = this.prepareTier(root, result);
    return this.commitTier(result.roomId, prepared);
  }

  /** Put the room's standard textures back and release its high textures. Returns the bytes freed. */
  revertTier(roomId) {
    this.check();
    const applied = this.tierApplications.get(roomId);
    if (!applied) return 0;
    this.tierApplications.delete(roomId);
    const clones = new Set();
    for (const { material, key, old, clone } of applied) {
      if (material[key] === clone) material[key] = old;
      clones.add(clone);
    }
    let freed = 0;
    const ids = new Set();
    for (const clone of clones) {
      freed += this.ledger.get(clone.uuid)?.bytes ?? 0;
      ids.add(clone.userData.textureId);
      clone.dispose();
      this.textures.delete(clone);
      this.ledger.delete(clone.uuid);
    }
    for (const id of ids) this.releaseTexture(id, 'high', roomId);
    this.highCache.delete(roomId);
    return freed;
  }

  /** Resident GPU-bound resources with their owning rooms, for per-room tier accounting. */
  residentResources() {
    const resources = [];
    for (const [key, users] of this.textureUsers) {
      if (key.endsWith(':high')) continue;
      const texture = this.textureCache.get(key)?.value;
      if (!texture) continue;
      resources.push({ id: key, tier: 'standard', bytes: this.ledger.get(texture.uuid)?.bytes ?? textureByteLength(texture), rooms: [...users] });
    }
    const high = new Map();
    for (const [roomId, applied] of this.tierApplications) {
      for (const { clone } of applied) {
        const id = `${clone.userData.textureId}:high`;
        if (!high.has(id)) high.set(id, { id, tier: 'high', bytes: this.ledger.get(clone.uuid)?.bytes ?? 0, rooms: new Set() });
        high.get(id).rooms.add(roomId);
      }
    }
    for (const resource of high.values()) resources.push({ ...resource, rooms: [...resource.rooms] });
    for (const [roomId, entry] of this.lightmapCache) {
      for (const atlas of entry.value?.values() ?? []) {
        resources.push({ id: `lightmap:${atlas.id}`, tier: 'standard', bytes: this.ledger.get(atlas.texture.uuid)?.bytes ?? 0, rooms: [roomId] });
      }
    }
    return resources;
  }

  snapshot(includeResources = true) {
    const resources = includeResources ? [...this.ledger.values()].map(record => ({ ...record })) : [];
    const allocations = new Map();
    for (const texture of this.textures) {
      const record = this.ledger.get(texture.uuid);
      if (!record?.uploaded) continue;
      // Matches r180 WebGLTextures' source + sampler/storage cache key.
      const key = [texture.source.uuid, texture.wrapS, texture.wrapT, texture.wrapR || 0, texture.magFilter,
        texture.minFilter, texture.anisotropy, texture.internalFormat, texture.format, texture.type,
        texture.generateMipmaps, texture.premultiplyAlpha, texture.flipY, texture.unpackAlignment, texture.colorSpace].join();
      allocations.set(key, record.bytes);
    }
    return { resources, gpuBytes: [...allocations.values()].reduce((sum, bytes) => sum + bytes, 0), fetchedAssets: includeResources ? [...this.fetchedAssets] : [] };
  }

  dispose() {
    if (this.disposed) return this.disposal;
    this.disposed = true;
    this.abort.abort();
    this.queue.length = 0;
    this.disposal = Promise.allSettled([...this.pending]).then(() => {
      for (const geometry of this.geometries) geometry.dispose();
      for (const material of this.materials) material.dispose();
      const images = new Set();
      for (const texture of this.textures) { texture.dispose(); if (texture.image?.close) images.add(texture.image); }
      for (const image of images) image.close();
      if (this.ktx.transcoderPending) this.ktx.dispose();
      if (--decoderUsers === 0) MeshoptDecoder.useWorkers(0);
      for (const url of this.blobs) URL.revokeObjectURL(url);
      for (const collection of [this.ledger, this.requests, this.textureCache, this.roomCache, this.highCache, this.lightmapCache,
        this.probeCache, this.backgroundCache, this.jobs, this.textureUsers, this.tierApplications, this.readyRooms,
        this.loadedRooms, this.textures, this.geometries, this.materials, this.blobs]) collection.clear();
      this.activeFetches = 0;
    });
    return this.disposal;
  }
}
