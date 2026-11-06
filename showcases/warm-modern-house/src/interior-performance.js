// Controller clocks and samples are presentation/GPU measurements, never CPU render duration.
export function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

export class AdaptiveScaleController {
  constructor() {
    this.scale = 1;
    this.refreshMs = null;
    this.timer = 'refresh';
    this.calibration = [];
    this.gpu = [];
    this.intervals = [];
    this.lowGpuFrames = 0;
    this.onCadence = 0;
    this.holdMs = 1000;
    this.holdUntil = 0;
    this.probe = null;
    this.epoch = 0;
    this.lastGpuMs = null;
  }

  calibrate(interval) {
    if (this.refreshMs !== null || !(interval > 0)) return;
    this.calibration.push(interval);
    if (this.calibration.length === 30) {
      const sorted = [...this.calibration].sort((a, b) => a - b);
      this.refreshMs = (sorted[14] + sorted[15]) / 2;
    }
  }

  change(scale) {
    scale = Math.max(0.5, Math.min(1, Math.round(scale * 10) / 10));
    if (scale === this.scale) return false;
    this.scale = scale;
    this.epoch++;
    this.resetWindows();
    return true;
  }

  resetWindows() {
    this.gpu.length = 0;
    this.intervals.length = 0;
    this.lowGpuFrames = this.onCadence = 0;
  }

  unavailable() {
    if (this.timer === 'gpu') this.resetWindows();
    this.timer = 'refresh';
    this.lastGpuMs = null;
  }

  gpuFrame(ms, epoch = this.epoch) {
    if (!Number.isFinite(ms) || ms < 0 || epoch !== this.epoch) return;
    if (this.timer !== 'gpu') { this.resetWindows(); this.probe = null; }
    this.timer = 'gpu';
    this.lastGpuMs = ms;
    this.gpu.push(ms);
    if (this.gpu.length > 20) this.gpu.shift();
    if (this.refreshMs === null || this.gpu.length < 20) return;
    const p90 = percentile(this.gpu, 0.9);
    if (p90 > 0.85 * this.refreshMs) {
      this.lowGpuFrames = 0;
      this.change(this.scale - 0.1);
    } else {
      this.lowGpuFrames = p90 < 0.60 * this.refreshMs ? this.lowGpuFrames + 1 : 0;
      if (this.lowGpuFrames >= 30) this.change(this.scale + 0.1);
    }
  }

  refreshFrame(interval, now) {
    if (this.timer !== 'refresh' || this.refreshMs === null || !(interval > 0)) return;
    const late = interval > 1.25 * this.refreshMs;
    this.intervals.push(late);
    if (this.intervals.length > 30) this.intervals.shift();
    this.onCadence = interval <= 1.10 * this.refreshMs ? this.onCadence + 1 : 0;
    const overloaded = this.intervals.length === 30 && this.intervals.filter(Boolean).length > 3;
    if (this.probe && now <= this.probe.until && overloaded) {
      const previous = this.probe.previous;
      this.probe = null;
      this.holdMs = Math.min(8000, this.holdMs * 2);
      this.holdUntil = now + this.holdMs;
      this.change(previous);
      return;
    }
    if (this.probe && now >= this.probe.until) this.probe = null;
    if (overloaded) {
      if (this.change(this.scale - 0.1)) this.holdUntil = now + this.holdMs;
      return;
    }
    if (this.onCadence >= 60 && now >= this.holdUntil && !this.probe && this.scale < 1) {
      const previous = this.scale;
      this.change(this.scale + 0.1);
      this.probe = { previous, until: now + 2000 };
    }
  }
}

// Only poll QUERY_RESULT after availability. No finish(), readPixels(), or synchronous waits.
class GpuTimer {
  constructor(renderer, controller) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.controller = controller;
    this.pending = [];
    this.available = [];
    this.active = null;
    this.results = [];
  }

  poll(now) {
    this.results.length = 0;
    if (!this.ext) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.clear();
      this.controller.unavailable();
      return;
    }
    while (this.pending.length) {
      const item = this.pending[0];
      if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) {
        // A driver which stops returning queries must not disable refresh fallback.
        if (now - item.started > 1000) { this.clear(); this.controller.unavailable(); }
        break;
      }
      this.pending.shift();
      const ms = gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6;
      this.available.push(item);
      if (Number.isFinite(ms) && ms >= 0) {
        this.results.push({ ms, startedMs: item.started, epoch: item.epoch });
        this.controller.gpuFrame(ms, item.epoch);
      }
    }
  }

  begin(now) {
    if (!this.ext || this.pending.length >= 60) return;
    // Reuse only queries whose results were consumed; outstanding timestamps stay untouched.
    const item = this.available.pop() ?? { query: this.gl.createQuery() };
    if (!item.query) return;
    item.started = now;
    item.epoch = this.controller.epoch;
    this.active = item;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, item.query);
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  clear() {
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active.query);
      this.active = null;
    }
    for (const item of this.pending) this.gl.deleteQuery(item.query);
    for (const item of this.available) this.gl.deleteQuery(item.query);
    this.pending.length = 0;
    this.available.length = 0;
  }
}

export class InteriorScheduler {
  constructor({ renderer, pipeline, update, render, isAnimating = () => false,
    measure = () => ({}), onState = () => {} }) {
    this.renderer = renderer;
    this.pipeline = pipeline;
    this.update = update;
    this.render = render;
    this.isAnimating = isAnimating;
    this.measure = measure;
    this.onState = onState;
    this.controller = new AdaptiveScaleController();
    this.gpuTimer = new GpuTimer(renderer, this.controller);
    this.state = 'idle';
    this.visible = true;
    this.inViewport = true;
    this.disposed = false;
    this.raf = 0;
    this.wakeTimer = 0;
    this.lastTime = null;
    this.lastFrameMs = null;
    this.lastChange = performance.now();
    this.refinedAt = null;
    this.frameCount = 0;
    this.dirty = true;
    this.previousMoving = false;
    this.inFrame = false;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.document = renderer.domElement.ownerDocument;
    this.visibilityChanged = () => this.syncVisibility();
    this.document.addEventListener('visibilitychange', this.visibilityChanged);
    this.observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      this.inViewport = entries[0].isIntersecting;
      this.syncVisibility();
    });
    this.observer?.observe(renderer.domElement);
    this.tick = now => this.frame(now);
    this.syncVisibility();
  }

  get active() { return this.visible && this.inViewport && !this.document.hidden && !this.disposed; }

  request(reason = 'scene') {
    if (this.disposed) return;
    this.reason = reason;
    this.dirty = true;
    this.lastChange = performance.now();
    this.refinedAt = null;
    this.state = 'idle';
    this.pipeline.invalidate();
    if (!this.inFrame) this.schedule();
  }

  setVisible(visible) {
    this.visible = !!visible;
    this.syncVisibility();
  }

  syncVisibility() {
    if (!this.active) {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.wakeTimer);
      this.raf = this.wakeTimer = 0;
      this.lastTime = null;
      this.previousMoving = false;
      this.gpuTimer.clear();
      this.controller.resetWindows();
      if (this.controller.refreshMs === null) this.controller.calibration.length = 0;
      this.pipeline.invalidate();
      this.state = 'idle';
      this.onState(this.snapshot, performance.now());
    } else this.request('visibility');
  }

  schedule(delay = 0) {
    if (!this.active || this.raf) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = 0;
    if (delay > 0) {
      this.wakeTimer = setTimeout(() => { this.wakeTimer = 0; this.schedule(); }, delay);
    } else this.raf = requestAnimationFrame(this.tick);
  }

  frame(now) {
    this.raf = 0;
    if (!this.active) return;
    this.inFrame = true;
    try {
      const interval = this.lastTime === null ? null : now - this.lastTime;
      this.lastTime = now;
      this.lastFrameMs = interval;
      if (this.controller.refreshMs === null) {
        if (interval !== null) this.controller.calibrate(interval);
        if (this.controller.refreshMs !== null) {
          this.resolveReady(true);
          this.lastTime = null;
        }
        this.schedule();
        this.onState(this.snapshot, now);
        return;
      }
      this.gpuTimer.poll(now);
      const changed = !!this.update(interval === null ? 0 : interval / 1000, now);
      const animating = !!this.isAnimating();
      const moving = changed || animating;
      const redraw = moving || this.dirty;
      this.dirty = false;
      if (redraw) {
        this.lastChange = now;
        this.refinedAt = null;
        this.pipeline.invalidate();
        this.state = animating ? 'animating' : moving ? 'moving' : 'idle';
        if (moving && this.previousMoving && interval !== null) this.controller.refreshFrame(interval, now);
        this.pipeline.setScale(this.controller.scale);
        // Uploads and other static invalidations still redraw, but the controller's
        // budget is defined over moving frames, not static redraw or compile cost.
        if (moving) this.gpuTimer.begin(now);
        try { this.render(false); } finally { if (moving) this.gpuTimer.end(); }
        this.frameCount++;
      } else if (now - this.lastChange >= 150) {
        this.pipeline.setScale(1);
        if (this.pipeline.samples < this.pipeline.sampleCap) {
          this.state = 'refining';
          this.render(true);
          this.frameCount++;
        }
        if (this.pipeline.samples >= this.pipeline.sampleCap) {
          this.state = 'refined';
          this.refinedAt ??= now;
        }
      } else this.state = 'idle';
      this.previousMoving = moving;
      if (redraw || this.dirty || this.controller.refreshMs === null || this.state === 'refining') this.schedule();
      else if (this.state !== 'refined') this.schedule(Math.max(0, 150 - (now - this.lastChange)));
      // No idle polling RAF: even the first second after refinement sleeps.
      else this.lastTime = null;
      this.onState(this.measureSnapshot(!moving), now);
      if (this.dirty) this.schedule();
    } finally { this.inFrame = false; }
  }

  get snapshot() { return this.measureSnapshot(true); }

  measureSnapshot(includeResources) {
    return {
      tier: null, evictions: [], ...this.measure(includeResources), state: this.state, renderScale: this.pipeline.scale,
      motionScale: this.controller.scale, samples: this.pipeline.samples,
      drawCalls: this.pipeline.lastSceneStats?.drawCalls ?? 0,
      triangles: this.pipeline.lastSceneStats?.triangles ?? 0,
      timer: this.controller.timer, refreshMs: this.controller.refreshMs,
      lastFrameMs: this.lastFrameMs, gpuMs: this.controller.lastGpuMs,
      gpuSamples: this.gpuTimer.results.map(item => ({ ...item })),
      drawingBuffer: [this.pipeline.width, this.pipeline.height],
      frames: this.frameCount, visible: this.active,
      timers: { raf: !!this.raf, wake: !!this.wakeTimer, pendingGpu: this.gpuTimer.pending.length,
        lastChangeMs: this.lastChange, refinedAtMs: this.refinedAt,
        probeUntilMs: this.controller.probe?.until ?? null, holdUntilMs: this.controller.holdUntil,
        holdMs: this.controller.holdMs, calibrationFrames: this.controller.calibration.length },
      shadowUpdates: this.pipeline.shadows?.updates ?? 0,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveReady(false);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.wakeTimer);
    this.raf = this.wakeTimer = 0;
    this.gpuTimer.clear();
    this.observer?.disconnect();
    this.document.removeEventListener('visibilitychange', this.visibilityChanged);
  }
}
