import { streamingPlan, diffStreamingPlan } from './interior-portals.js';

// Executes the portal-graph streaming plan (P0 current room standard, P1 its high tier, P2 portal
// neighbours, P3 the rest). It owns request lifecycle only: the loader fetches/decodes, the owner
// binds a loaded room into the scene (bindStandard) and keeps a loaded high tier (acceptHigh).
// Stale requests abort when the plan stops asking for them; priority changes are forwarded to
// the loader; a failed request is reported once and not retried until retryFailed().
const key = (room, tier) => `${room}\u0000${tier}`;
const isAbort = error => error?.name === 'AbortError';
const abortError = () => new DOMException('Room request was cancelled.', 'AbortError');

export class RoomStreamer {
  constructor({ graph, loader, current, bindStandard, acceptHigh = async () => {}, whenReady = async () => {},
    onFailure = () => {}, alsoHigh = [] }) {
    if (!graph?.rooms?.has(current)) throw new Error(`RoomStreamer needs a known current room: ${String(current)}`);
    this.graph = graph;
    this.loader = loader;
    this.current = current;
    this.bindStandard = bindStandard;
    this.acceptHigh = acceptHigh;
    // Resolves when the room has rendered its standard frame (the loader refuses high tiers before that).
    this.whenReady = whenReady;
    this.onFailure = onFailure;
    // Rooms whose high tier is wanted at P3 even when far away (a warm benchmark refines its whole path).
    this.alsoHigh = alsoHigh.map(room => {
      if (!graph.rooms.has(room)) throw new Error(`alsoHigh names unknown room: ${String(room)}`);
      return room;
    });
    this.resident = new Map([...graph.rooms.keys()].map(id => [id, new Set()]));
    this.banned = new Set();
    this.globalTier = 'high';
    this.inflight = new Map();
    this.failed = new Map();
    this.plan = [];
    this.disposed = false;
  }

  priorityOf(room, tier) { return this.plan.find(request => request.room === room && request.tier === tier)?.priority; }

  start() { return this.reconcile(); }

  setCurrent(room) {
    if (!this.graph.rooms.has(room)) throw new Error(`Unknown current room: ${String(room)}`);
    this.current = room;
    // The room the visitor is in always gets its high tier requested again.
    this.banned.delete(room);
    return this.reconcile();
  }

  setGlobalTier(tier) {
    if (!['standard', 'high'].includes(tier)) throw new Error(`Unknown tier: ${String(tier)}`);
    this.globalTier = tier;
    return this.reconcile();
  }

  /** Drop a room's high tier after eviction. It is not requested again until the room becomes current. */
  evictHigh(room) {
    this.resident.get(room)?.delete('high');
    this.banned.add(room);
    return this.reconcile();
  }

  retryFailed() {
    const count = this.failed.size;
    this.failed.clear();
    this.reconcile();
    return count;
  }

  /**
   * A loaded high tier whose publication failed (a texture upload threw): the room stays at the
   * standard tier and the failure is reported exactly like a failed request, so the same retry
   * action requests the tier again. The failed entry stops the plan from asking for it at once.
   */
  failHigh(room, error) {
    this.resident.get(room)?.delete('high');
    this.failed.set(key(room, 'high'), error);
    this.onFailure({ room, tier: 'high', priority: this.priorityOf(room, 'high') ?? 'P1', error });
    return this.reconcile();
  }

  has(room, tier) { return this.resident.get(room)?.has(tier) ?? false; }

  reconcile() {
    if (this.disposed) return { abort: [], start: [], reprioritize: [] };
    const tiers = new Map();
    for (const [id, set] of this.resident) {
      const seen = new Set(set);
      // A suppressed high tier is treated as already satisfied so the plan never asks for it.
      if (this.globalTier === 'standard' || this.banned.has(id)) seen.add('high');
      tiers.set(id, seen);
    }
    const wanted = streamingPlan({ graph: this.graph, current: this.current, tiers });
    for (const room of this.alsoHigh) {
      if (!tiers.get(room).has('high') && !wanted.some(request => request.room === room && request.tier === 'high')) {
        wanted.push({ room, tier: 'high', priority: 'P3' });
      }
    }
    const next = wanted
      // A room whose standard tier failed has no high tier to request; a retry re-adds both.
      .filter(request => !this.failed.has(key(request.room, request.tier))
        && !(request.tier === 'high' && this.failed.has(key(request.room, 'standard'))));
    const diff = diffStreamingPlan(this.plan, next);
    this.plan = next;
    for (const request of diff.abort) {
      const k = key(request.room, request.tier);
      const entry = this.inflight.get(k);
      if (!entry) continue;
      // Detach first so the same request may be restarted immediately if the plan flips back.
      this.inflight.delete(k);
      entry.controller.abort();
    }
    for (const request of diff.reprioritize) this.loader.reprioritize(request.room, request.tier, request.priority);
    for (const request of diff.start) {
      if (!this.inflight.has(key(request.room, request.tier))) this.begin(request);
    }
    return diff;
  }

  begin(request) {
    const k = key(request.room, request.tier);
    const controller = new AbortController();
    const entry = { request, controller, done: null };
    this.inflight.set(k, entry);
    entry.done = (async () => {
      try { await this.execute(request, controller.signal); }
      catch (error) {
        if (isAbort(error) || controller.signal.aborted) return;
        this.failed.set(k, error);
        this.onFailure({ room: request.room, tier: request.tier, priority: this.priorityOf(request.room, request.tier) ?? request.priority, error });
      } finally {
        if (this.inflight.get(k) === entry) this.inflight.delete(k);
        this.reconcile();
      }
    })();
  }

  async execute(request, signal) {
    const { room, tier } = request;
    const priority = () => this.priorityOf(room, tier) ?? request.priority;
    if (tier === 'standard') {
      const result = await this.loader.loadRoom(room, { tier, priority: priority(), signal });
      if (signal.aborted || this.disposed) throw abortError();
      await this.bindStandard(room, result);
      this.resident.get(room).add('standard');
      return;
    }
    await this.whenStandard(room, signal);
    await this.whenReady(room, signal);
    if (signal.aborted) throw abortError();
    const result = await this.loader.loadRoom(room, { tier, priority: priority(), signal });
    if (signal.aborted || this.disposed) throw abortError();
    await this.acceptHigh(room, result);
    this.resident.get(room).add('high');
  }

  /** Resolves once the room's standard tier is bound; rejects with the load error if it failed. */
  async whenStandard(room, signal) {
    for (;;) {
      if (this.resident.get(room).has('standard')) return;
      if (signal?.aborted) throw abortError();
      const failure = this.failed.get(key(room, 'standard'));
      if (failure) throw failure;
      const entry = this.inflight.get(key(room, 'standard'));
      if (!entry) throw abortError();
      await entry.done;
    }
  }

  snapshot() {
    return {
      current: this.current, globalTier: this.globalTier,
      resident: Object.fromEntries([...this.resident].map(([id, set]) => [id, [...set].sort()])),
      plan: this.plan.map(request => ({ ...request })),
      inflight: [...this.inflight.values()].map(entry => ({ room: entry.request.room, tier: entry.request.tier,
        priority: this.priorityOf(entry.request.room, entry.request.tier) ?? entry.request.priority })),
      failed: [...this.failed].map(([k, error]) => { const [room, tier] = k.split('\u0000'); return { room, tier, message: error.message }; }),
      banned: [...this.banned],
    };
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
  }
}
