import { percentile } from './interior-performance.js';

export function benchmarkOptions(search = globalThis.location.search) {
  const query = new URLSearchParams(search);
  if (!query.has('benchmark')) return null;
  const match = /^(\d+)x(\d+)$/.exec(query.get('size') || '1920x1080');
  const mode = query.get('run') || 'warm';
  const repetition = Number(query.get('rep') || 1);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || !['cold', 'warm'].includes(mode)
    || !Number.isInteger(repetition) || repetition < 1 || repetition > 3) {
    throw new Error('Benchmark requires size=<width>x<height>, run=cold|warm, rep=1|2|3.');
  }
  return { pathId: query.get('benchmark'), size: [Number(match[1]), Number(match[2])],
    mode, repetition, stress: query.get('stress') === '1' };
}

export async function hashFetchedBytes(url, bytes, metadata = {}) {
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError('Benchmark hashes require the actual fetched response bytes.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { ...metadata, url, bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
}

function requireRecord(record, label) {
  if (!record || typeof record.url !== 'string' || !record.url || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`${label} requires a fetched-byte {url,bytes,sha256} record, not a URL-only claim.`);
  }
  return { ...record };
}

function pathDurations(path) {
  if (!(path.speed > 0) || !Array.isArray(path.keys) || path.keys.length < 2) {
    throw new Error('Benchmark path requires positive speed and at least two keys.');
  }
  for (const key of path.keys) {
    for (const field of ['position', 'target']) {
      if (!Array.isArray(key[field]) || key[field].length !== 3 || !key[field].every(Number.isFinite)) {
        throw new Error(`Benchmark path key ${field} must be a finite three-vector.`);
      }
    }
    if (key.stopMs !== undefined && (!Number.isFinite(key.stopMs) || key.stopMs < 0)) {
      throw new Error('Benchmark path stopMs must be nonnegative.');
    }
  }
  const durations = path.keys.slice(1).map((key, index) => Math.hypot(
    ...key.position.map((value, axis) => value - path.keys[index].position[axis])) / path.speed * 1000);
  if (durations.reduce((total, value) => total + value, 0) < 20000) {
    throw new Error(`Benchmark path ${path.id} must declare at least 20 seconds of motion; it is not stretched or repeated in-page.`);
  }
  return durations;
}

// One invocation records one real repetition. An external browser harness owns cache,
// network emulation, fresh cold navigations, the three repetitions and aggregation.
export class InteriorBenchmark {
  constructor({ manifest, camera, controls, scheduler, renderer, manifestRecord, budgetRecord,
    viewerRecords = [], networkConditions = null, environment = null, shaderCompilation = [],
    options = benchmarkOptions(), requirement = () => ({ urls: new Set(), complete: true }),
    onComplete = () => {}, onError = () => {},
    captureId = globalThis.__interiorBenchmarkContext?.captureId ?? null }) {
    if (!options) throw new Error('No benchmark query was requested.');
    this.options = options;
    this.path = manifest.paths.find(path => path.id === options.pathId);
    if (!this.path) throw new Error(`Unknown benchmark path: ${options.pathId}`);
    this.durations = pathDurations(this.path);
    // Receipts must bind the fetched bytes of every room the path crosses: finish() waits until
    // requirement() reports its assets as fetched.
    this.requirement = requirement;
    this.camera = camera;
    this.controls = controls;
    this.scheduler = scheduler;
    this.renderer = renderer;
    this.manifestRecord = manifestRecord;
    this.budgetRecord = budgetRecord;
    this.viewerRecords = viewerRecords;
    this.networkConditions = networkConditions;
    this.environment = environment;
    this.captureId = captureId;
    this.onComplete = onComplete;
    this.onError = onError;
    this.assets = [];
    this.phase = 'waiting';
    this.interactiveAt = null;
    this.refinementReady = false;
    this.frames = [];
    this.gpuSamples = [];
    this.longTasks = [];
    this.navigationWindows = [];
    this.stops = [];
    this.snapshots = [];
    this.shaderCompilation = shaderCompilation;
    this.peakGpuBytes = null;
    this.timer = 0;
    this.disposed = false;
    this.receipt = null;
    this.error = null;
    this.longTaskSupported = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('longtask');
    this.observer = this.longTaskSupported ? new PerformanceObserver(list => this.captureTasks(list.getEntries())) : null;
    this.observer?.observe({ type: 'longtask', buffered: true });
    this.scheduler.pipeline.setStress(options.stress);
  }

  recordAsset(record) { this.assets.push(requireRecord(record, 'Fetched asset')); }

  recordShaderCompilation(startMs, endMs, label = 'scene') {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      throw new Error('Shader compilation requires measured start/end performance timestamps.');
    }
    this.shaderCompilation.push({ startMs, durationMs: endMs - startMs, label });
  }

  captureTasks(entries) {
    for (const entry of entries) this.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
  }

  markInteractive(now = performance.now()) {
    if (this.interactiveAt !== null) return;
    this.interactiveAt = now;
    if (this.options.mode === 'cold') this.start(now);
    else this.maybeStartWarm();
  }

  markRefinementReady() {
    this.refinementReady = true;
    this.maybeStartWarm();
  }

  maybeStartWarm() {
    if (this.options.mode === 'warm' && this.phase === 'waiting' && this.interactiveAt !== null
      && this.refinementReady && this.scheduler.snapshot.state === 'refined') {
      this.wake(() => {
        if (this.scheduler.snapshot.state === 'refined') this.start(performance.now());
      });
    }
  }

  wake(callback, delay = 0) {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = 0; if (!this.disposed) callback(); }, delay);
  }

  start(now) {
    if (this.disposed || this.phase !== 'waiting') return;
    const actual = this.scheduler.snapshot.drawingBuffer;
    if (actual[0] !== this.options.size[0] || actual[1] !== this.options.size[1]) {
      this.fail(new Error(`Benchmark requested ${this.options.size.join('x')}, actual drawing buffer is ${actual.join('x')}.`));
      return;
    }
    this.startedAt = now;
    this.originalControlsEnabled = this.controls?.enabled;
    if (this.controls) this.controls.enabled = false;
    this.keyIndex = 0;
    this.pose(this.path.keys[0], this.path.keys[0], 0);
    // Cold navigation starts immediately at P0, without waiting for the first stop/P1:
    // the cold run must overlap P1-P3 streaming and batch building with motion, so it
    // departs the first key at once and only observes the stops it reaches. A warm run
    // starts after full refinement and rests at the first declared hold.
    if (this.options.mode === 'cold' || this.holdMs(0) <= 0) this.beginMotion(now);
    else this.beginStop(now);
    this.scheduler.request('benchmark-start');
  }

  // The declared rest at a key; an omitted stopMs is no stop at all, in the audit and here.
  holdMs(index) { return this.path.keys[index].stopMs || 0; }

  pose(from, to, fraction) {
    const interpolate = field => from[field].map((value, axis) => value + (to[field][axis] - value) * fraction);
    const position = interpolate('position');
    const target = interpolate('target');
    this.camera.position.set(...position);
    this.camera.lookAt(...target);
    this.camera.updateMatrixWorld();
    this.controls?.target.set(...target);
  }

  beginMotion(now) {
    this.phase = 'moving';
    this.segmentStart = now;
    this.lastMotionFrame = null;
    this.navigationWindows.push({ startMs: now, endMs: null });
  }

  beginStop(now) {
    this.phase = 'stopping';
    this.stops.push({ keyIndex: this.keyIndex, startMs: now, convergence16Ms: null,
      refinedMs: null, position: [...this.path.keys[this.keyIndex].position],
      target: [...this.path.keys[this.keyIndex].target] });
  }

  // Invoke from scheduler.update. Controls must not update/clamp this authored pose afterward.
  update(_delta, now) {
    if (this.phase !== 'moving') return false;
    const from = this.path.keys[this.keyIndex];
    const to = this.path.keys[this.keyIndex + 1];
    const duration = this.durations[this.keyIndex];
    const fraction = duration === 0 ? 1 : Math.min(1, (now - this.segmentStart) / duration);
    this.pose(from, to, fraction);
    if (fraction === 1) {
      const next = this.keyIndex + 1;
      if (this.holdMs(next) > 0) {
        this.navigationWindows.at(-1).endMs = now;
        this.keyIndex = next;
        this.beginStop(now);
      } else if (next < this.path.keys.length - 1) {
        // A key without a declared hold is passed through: motion carries on in the same window.
        this.keyIndex = next;
        this.segmentStart += duration;
      } else {
        // The last key declares no hold: there is nothing to rest or refine at, so the run ends here.
        this.navigationWindows.at(-1).endMs = now;
        this.keyIndex = next;
        this.phase = 'finishing';
        this.wake(() => { this.finish().catch(error => this.fail(error)); });
      }
    }
    return true;
  }

  // Invoke once from scheduler.onState; never recursively request a frame here.
  recordFrame(snapshot, now = performance.now()) {
    if (this.disposed) return;
    if (this.phase === 'waiting') { this.maybeStartWarm(); return; }
    if (['complete', 'failed', 'finishing'].includes(this.phase)) return;
    if (!snapshot.visible) { this.fail(new Error('Benchmark interrupted by hidden document or offscreen canvas.')); return; }
    if (snapshot.drawingBuffer.some((value, axis) => value !== this.options.size[axis])) {
      this.fail(new Error('Benchmark drawing buffer changed during the run.'));
      return;
    }
    if (Number.isFinite(snapshot.gpuBytes)) this.peakGpuBytes = Math.max(this.peakGpuBytes ?? 0, snapshot.gpuBytes);
    for (const sample of snapshot.gpuSamples || []) this.gpuSamples.push({ ...sample });
    const window = this.navigationWindows.at(-1);
    const movingFrame = window && now >= window.startMs && (window.endMs === null || now <= window.endMs);
    if (movingFrame) {
      if (this.lastMotionFrame !== null && now > this.lastMotionFrame) {
        this.frames.push({ atMs: now, intervalMs: now - this.lastMotionFrame,
          scale: snapshot.renderScale, drawCalls: snapshot.drawCalls, triangles: snapshot.triangles,
          currentRoom: snapshot.currentRoom ?? null, visibleRooms: [...(snapshot.visibleRooms ?? [])],
          nonCurrentDrawCalls: snapshot.nonCurrentDrawCalls ?? null });
      }
      this.lastMotionFrame = now;
    }
    if (this.phase !== 'stopping') return;
    const stop = this.stops.at(-1);
    if (snapshot.samples >= 16 && stop.convergence16Ms === null) {
      stop.convergence16Ms = now - stop.startMs;
      stop.convergence16Observation = { atMs: now, samples: snapshot.samples,
        drawingBuffer: [...snapshot.drawingBuffer], renderScale: snapshot.renderScale };
    }
    if (snapshot.state !== 'refined') return;
    stop.refinedMs ??= now - stop.startMs;
    if (!stop.snapshot) { stop.snapshot = snapshot; this.snapshots.push(snapshot); }
    const remaining = Math.max(0, stop.startMs + (this.path.keys[this.keyIndex].stopMs || 0) - now);
    this.wake(() => {
      if (this.scheduler.snapshot.state !== 'refined') return;
      if (this.keyIndex === this.path.keys.length - 1) {
        this.finish().catch(error => this.fail(error));
      } else {
        this.beginMotion(performance.now());
        this.scheduler.request('benchmark-segment');
      }
    }, remaining);
  }

  restoreControls() {
    if (this.controls && this.originalControlsEnabled !== undefined) this.controls.enabled = this.originalControlsEnabled;
  }

  async finish() {
    this.phase = 'finishing';
    for (;;) {
      const need = this.requirement();
      const have = new Set(this.assets.map(record => record.url));
      if (need.complete && [...need.urls].every(url => have.has(url))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
      if (this.disposed || this.phase !== 'finishing') return null;
    }
    this.captureTasks(this.observer?.takeRecords() || []);
    this.observer?.disconnect();
    this.restoreControls();
    const manifest = requireRecord(this.manifestRecord, 'Manifest');
    const budget = requireRecord(this.budgetRecord, 'Runtime budget');
    if (!this.viewerRecords.length || !this.assets.length) throw new Error('Benchmark requires actual viewer build and fetched asset hash records.');
    const viewer = this.viewerRecords.map(record => requireRecord(record, 'Viewer build'));
    const pathBytes = new TextEncoder().encode(JSON.stringify(this.path));
    const pathHash = await hashFetchedBytes(`manifest.paths/${this.path.id}`, pathBytes);
    const intervals = this.frames.map(frame => frame.intervalMs);
    if (!intervals.length) throw new Error('Benchmark produced no motion presentation intervals.');
    const gl = this.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const taskRecords = this.longTasks.map(task => {
      const overlapMs = this.navigationWindows.reduce((sum, window) => sum + Math.max(0,
        Math.min(task.startMs + task.durationMs, window.endMs) - Math.max(task.startMs, window.startMs)), 0);
      return { ...task, overlapMs, phase: overlapMs > 0 ? 'navigation' : task.startMs < this.startedAt ? 'startup' : 'refinement' };
    });
    const snapshot = this.scheduler.snapshot;
    const motionDurationMs = this.navigationWindows.reduce((sum, window) => sum + window.endMs - window.startMs, 0);
    const gpu = this.gpuSamples.filter(sample => this.navigationWindows.some(window =>
      sample.startedMs >= window.startMs && sample.startedMs <= window.endMs));
    this.receipt = {
      schemaVersion: 1, mode: this.options.mode, repetition: this.options.repetition,
      pathId: this.path.id, size: this.options.size, drawingBuffer: snapshot.drawingBuffer,
      device: { renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        userAgent: navigator.userAgent, devicePixelRatio: globalThis.devicePixelRatio },
      captureId: this.captureId,
      networkConditions: this.networkConditions, environment: this.environment,
      stress: this.options.stress, longTaskObserverSupported: this.longTaskSupported,
      hashes: { assets: this.assets.map(record => ({ ...record })), viewer,
        manifest: manifest.sha256, budget: budget.sha256, path: pathHash.sha256 },
      hashSources: { manifest, budget, path: { ...pathHash, serialization: 'JSON.stringify', definition: this.path } },
      navigation: { startMs: this.navigationWindows[0].startMs, endMs: this.navigationWindows.at(-1).endMs,
        durationMs: motionDurationMs, windows: this.navigationWindows,
        frameIntervalsMs: intervals,
        frames: this.frames.map(frame => ({ ...frame })),
        frameMs: { p50: percentile(intervals, 0.5), p95: percentile(intervals, 0.95), p99: percentile(intervals, 0.99) },
        gpuTimesMs: gpu.map(sample => sample.ms), gpuSamples: gpu,
        longTasks: taskRecords.filter(task => task.phase === 'navigation') },
      renderScale: { min: Math.min(...this.frames.map(frame => frame.scale)), max: Math.max(...this.frames.map(frame => frame.scale)) },
      drawCalls: { max: Math.max(...this.frames.map(frame => frame.drawCalls)),
        nonCurrentMax: Math.max(0, ...this.frames.map(frame => frame.nonCurrentDrawCalls ?? 0)) },
      rooms: { path: [...this.path.rooms], visited: [...new Set(this.frames.map(frame => frame.currentRoom).filter(Boolean))] },
      triangles: { max: Math.max(...this.frames.map(frame => frame.triangles)) },
      ttiMs: this.interactiveAt,
      shaderCompilation: this.shaderCompilation, gpuBytes: { max: this.peakGpuBytes },
      convergence16Ms: this.stops.map(stop => stop.convergence16Ms), stops: this.stops,
      longTasks: taskRecords, snapshots: this.snapshots,
    };
    this.phase = 'complete';
    this.onComplete(this.receipt);
    return this.receipt;
  }

  fail(error) {
    this.error = error.message;
    this.phase = 'failed';
    clearTimeout(this.timer);
    this.timer = 0;
    this.observer?.disconnect();
    this.restoreControls();
    this.onError(error);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = 0;
    this.observer?.disconnect();
    this.restoreControls();
  }
}
