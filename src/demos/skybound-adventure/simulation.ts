import { PHYSICS_DT } from "./contracts";
import type {
  GameState,
  InputFrame,
  LevelDefinition,
  PlayerState,
  Rect,
  Simulation,
} from "./contracts";
import { LEVEL } from "./level";

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
interface CollisionBody {
  bounds: Rect;
  parts: readonly Rect[];
  movingId: string | null;
}
const overlapsBody = (rect: Rect, body: CollisionBody): boolean => {
  if (!overlaps(rect, body.bounds)) return false;
  for (const part of body.parts) if (overlaps(rect, part)) return true;
  return false;
};
const approach = (value: number, target: number, amount: number): number =>
  value < target
    ? Math.min(target, value + amount)
    : Math.max(target, value - amount);
const freshPlayer = (level: LevelDefinition): PlayerState => ({
  ...level.spawn,
  w: 26,
  h: 42,
  vx: 0,
  vy: 0,
  facing: 1,
  grounded: false,
  wallSide: 0,
  jumpsUsed: 0,
  health: 3,
  invulnerable: 0,
  dashTime: 0,
  dashCooldown: 0,
  animation: "idle",
  riding: null,
});

/** Browser-independent seconds-based simulation. Large calls are sliced for collision safety. */
export function createSimulation(level: LevelDefinition = LEVEL): Simulation {
  const state: GameState = {
    time: 0,
    tick: 0,
    phase: "playing",
    player: freshPlayer(level),
    movers: level.platforms
      .filter((p) => p.kind === "moving")
      .map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, dx: 0, dy: 0 })),
    enemies: level.enemies.map((e) => ({ ...e })),
    crystals: level.crystals.map((c) => ({ ...c })),
    checkpoints: level.checkpoints.map((c) => ({ ...c })),
    collected: 0,
    deaths: 0,
    respawnTime: 0,
    checkpointId: null,
    message: "",
  };
  // Broad-phase bounds never participate in narrow-phase collision response.
  const solids: CollisionBody[] = level.platforms.map((platform) => {
    const bounds = platform.kind === "moving"
      ? state.movers.find((mover) => mover.id === platform.id)!
      : platform;
    return {
      bounds,
      parts: platform.kind === "moving" ? [bounds] : platform.collisionRects ?? [bounds],
      movingId: platform.kind === "moving" ? platform.id : null,
    };
  });
  const carrierSweep: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const stepSweep: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const headSweep: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const moverDefinitions = level.platforms.filter(
    (platform) => platform.kind === "moving",
  );
  const moverTimes = new Float64Array(moverDefinitions.length);
  let coyote = 0;
  let jumpBuffer = 0;
  let wallLock = 0;
  const p = state.player;

  function resetMotion(): void {
    p.vx = 0;
    p.vy = 0;
    p.grounded = false;
    p.wallSide = 0;
    p.jumpsUsed = 0;
    p.riding = null;
    p.dashTime = 0;
    p.dashCooldown = 0;
    coyote = 0;
    jumpBuffer = 0;
    wallLock = 0;
  }
  function restart(): void {
    Object.assign(p, freshPlayer(level));
    state.time = 0;
    state.tick = 0;
    state.phase = "playing";
    state.collected = 0;
    state.deaths = 0;
    state.respawnTime = 0;
    state.checkpointId = null;
    state.message = "";
    for (let i = 0; i < state.enemies.length; i++)
      Object.assign(state.enemies[i]!, level.enemies[i]);
    for (let i = 0; i < state.crystals.length; i++)
      Object.assign(state.crystals[i]!, level.crystals[i]);
    for (let i = 0; i < state.checkpoints.length; i++)
      Object.assign(state.checkpoints[i]!, level.checkpoints[i]);
    for (const m of state.movers) {
      const original = level.platforms.find((s) => s.id === m.id)!;
      m.x = original.x;
      m.y = original.y;
      m.dx = 0;
      m.dy = 0;
    }
    moverTimes.fill(0);
    resetMotion();
  }
  function die(): void {
    if (state.phase !== "playing") return;
    state.deaths++;
    state.phase = "respawning";
    state.respawnTime = 0.55;
    resetMotion();
    p.animation = "dead";
    state.message = p.health <= 0
      ? "Out of hearts · Starting a new journey…"
      : "Returning to the last sky beacon…";
  }
  function damage(direction: number): void {
    if (p.invulnerable > 0 || state.phase !== "playing") return;
    p.health--;
    p.invulnerable = 1.3;
    p.dashTime = 0;
    if (p.health <= 0) {
      die();
      return;
    }
    p.vx = direction * 220;
    p.vy = -300;
    p.grounded = false;
    p.riding = null;
    wallLock = 0.18;
  }
  function moveX(amount: number, ignore: Rect | null = null, canStep = false): void {
    if (amount === 0) return;
    p.x += amount;
    let target = p.x;
    let blocked = false;
    for (const body of solids) {
      if (body.bounds === ignore || !overlaps(p, body.bounds)) continue;
      for (const part of body.parts) {
        if (!overlaps(p, part)) continue;
        target = amount > 0 ? Math.min(target, part.x - p.w) : Math.max(target, part.x + part.w);
        blocked = true;
      }
    }
    if (blocked && canStep) {
      // Native contour stairs are not walls. Sweep headroom over the whole move;
      // never step through a low ceiling or climb a real ledge without jumping.
      stepSweep.x = Math.min(p.x - amount, p.x);
      stepSweep.w = p.w + Math.abs(amount);
      stepSweep.h = p.h;
      for (let rise = 1; rise <= 4; rise++) {
        stepSweep.y = p.y - rise;
        let clear = true;
        for (const body of solids) {
          if (body.bounds !== ignore && overlapsBody(stepSweep, body)) {
            clear = false;
            break;
          }
        }
        if (clear) {
          p.y -= rise;
          target = p.x;
          blocked = false;
          break;
        }
      }
    }
    if (blocked) {
      p.wallSide = amount > 0 ? 1 : -1;
      p.vx = 0;
      p.dashTime = 0;
    }
    p.x = Math.max(0, Math.min(level.width - p.w, target));
  }
  function clearOfSolids(rect: Rect, ignore: Rect | null = null): boolean {
    for (const body of solids)
      if (body.bounds !== ignore && overlapsBody(rect, body)) return false;
    return true;
  }
  function moveY(amount: number, ignore: Rect | null = null): void {
    if (amount === 0) return;
    p.y += amount;
    let target = p.y;
    let blocked = false;
    let riding: string | null = null;
    for (const body of solids) {
      if (body.bounds === ignore || !overlaps(p, body.bounds)) continue;
      for (const part of body.parts) {
        if (!overlaps(p, part)) continue;
        const contact = amount > 0 ? part.y - p.h : part.y + part.h;
        if (amount > 0 ? contact <= target : contact >= target) {
          target = contact;
          riding = body.movingId;
        }
        blocked = true;
      }
    }
    if (blocked && amount < 0 && p.vy < 0 && ignore === null) {
      // Slide off shallow head corners, but only along two unobstructed sweeps.
      // The full body and real ceilings remain solid; carriers never get this assist.
      for (let distance = 1; distance <= 4; distance++) {
        for (let side = 0; side < 2; side++) {
          const offset = (side === 0 ? -p.facing : p.facing) * distance;
          const x = p.x + offset;
          if (x < 0 || x + p.w > level.width) continue;
          headSweep.x = Math.min(p.x, x);
          headSweep.y = p.y - amount;
          headSweep.w = p.w + distance;
          headSweep.h = p.h;
          if (!clearOfSolids(headSweep)) continue;
          headSweep.x = x;
          headSweep.y = p.y;
          headSweep.w = p.w;
          headSweep.h = p.h - amount;
          if (!clearOfSolids(headSweep)) continue;
          p.x = x;
          return;
        }
      }
    }
    p.y = target;
    if (blocked) {
      if (amount > 0) {
        p.grounded = true;
        p.jumpsUsed = 0;
        p.riding = riding;
      }
      p.vy = 0;
    }
  }
  function tick(dt: number, input: InputFrame, pressed: boolean): boolean {
    state.time += dt;
    state.tick++;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    wallLock = Math.max(0, wallLock - dt);
    for (let moverIndex = 0; moverIndex < state.movers.length; moverIndex++) {
      const m = state.movers[moverIndex]!;
      const base = moverDefinitions[moverIndex]!;
      const nextMoverTime = moverTimes[moverIndex]! + dt;
      const t =
        (1 - Math.cos((nextMoverTime * Math.PI * 2) / (base.period ?? 4))) / 2;
      const x = base.x + (base.travelX ?? 0) * t;
      const y = base.y + (base.travelY ?? 0) * t;
      m.dx = x - m.x;
      m.dy = y - m.y;
      m.x = x;
      m.y = y;
      let blocked = false;
      // Preflight every displaced body, including a jumper that just lost riding.
      // Otherwise a head bonk lets the next carrier step crush a non-rider.
      let carriedX = p.x;
      let carriedY = p.y;
      if (state.phase === "playing") {
        const rider = p.riding === m.id;
        const pushed = !rider && overlaps(p, m);
        if (rider) {
          carriedX += m.dx;
          carriedY += m.dy;
        } else if (pushed) {
          if (p.y + p.h - m.dy <= m.y + 0.1) carriedY = m.y - p.h;
          else if (m.dx > 0) carriedX = m.x + m.w;
          else if (m.dx < 0) carriedX = m.x - p.w;
          else if (m.dy > 0) carriedY = m.y + m.h;
          else carriedY = m.y - p.h;
        }
        if (rider || pushed) {
          carrierSweep.x = Math.min(p.x, carriedX);
          carrierSweep.y = Math.min(p.y, carriedY);
          carrierSweep.w = Math.abs(carriedX - p.x) + p.w;
          carrierSweep.h = Math.abs(carriedY - p.y) + p.h;
          if (!clearOfSolids(carrierSweep, m)) {
            blocked = true;
            m.x -= m.dx;
            m.y -= m.dy;
            m.dx = 0;
            m.dy = 0;
          }
        }
      }
      // Pause the carrier's own phase as well as its position: resuming cannot
      // accumulate a large catch-up delta and teleport a rider through a ceiling.
      if (!blocked) moverTimes[moverIndex] = nextMoverTime;
      if (state.phase === "playing" && p.riding === m.id) {
        moveX(m.dx, m);
        moveY(m.dy, m);
        // A blocked rider is detached rather than forced through a ceiling or wall.
        if (
          Math.abs(p.y + p.h - m.y) > 0.05 ||
          p.x + p.w <= m.x ||
          p.x >= m.x + m.w
        )
          p.riding = null;
      }
      if (!blocked && state.phase === "playing" && overlaps(p, m)) {
        const onTop = p.y + p.h - m.dy <= m.y + 0.1;
        p.x = carriedX;
        p.y = carriedY;
        if (onTop) {
          p.vy = 0;
          p.grounded = true;
          p.riding = m.id;
        }
      }
    }
    if (state.phase === "respawning") {
      state.respawnTime = Math.max(0, state.respawnTime - dt);
      if (state.respawnTime === 0) {
        if (p.health <= 0) {
          restart();
          return true;
        }
        const checkpoint = state.checkpoints.find(
          (c) => c.id === state.checkpointId,
        );
        p.x = checkpoint?.spawnX ?? level.spawn.x;
        p.y = checkpoint?.spawnY ?? level.spawn.y;
        resetMotion();
        p.invulnerable = 1.3;
        p.animation = "idle";
        state.phase = "playing";
        state.message = "";
      }
      return false;
    }
    if (pressed && input.jumpPressed) jumpBuffer = 0.13;
    else jumpBuffer = Math.max(0, jumpBuffer - dt);
    coyote = p.grounded ? 0.09 : Math.max(0, coyote - dt);
    p.wallSide = 0;
    for (const body of solids) {
      if (p.x + p.w < body.bounds.x - 0.5 || p.x > body.bounds.x + body.bounds.w + 0.5 ||
          p.y + p.h <= body.bounds.y + 1 || p.y >= body.bounds.y + body.bounds.h - 1) continue;
      for (const part of body.parts) {
        if (p.y + p.h <= part.y + 1 || p.y >= part.y + part.h - 1) continue;
        if (Math.abs(p.x + p.w - part.x) < 0.5) p.wallSide = 1;
        else if (Math.abs(p.x - part.x - part.w) < 0.5) p.wallSide = -1;
      }
    }
    if (jumpBuffer > 0) {
      if (p.grounded || coyote > 0) {
        p.vy = -560;
        p.jumpsUsed = 1;
        coyote = 0;
        jumpBuffer = 0;
        p.grounded = false;
        p.riding = null;
        p.dashTime = 0;
      } else if (p.wallSide !== 0) {
        p.vx = -p.wallSide * 330;
        p.facing = p.wallSide === 1 ? -1 : 1;
        p.vy = -550;
        p.jumpsUsed = 1;
        wallLock = 0.16;
        jumpBuffer = 0;
        p.dashTime = 0;
      } else if (p.jumpsUsed < 2) {
        p.vy = -500;
        p.jumpsUsed = 2;
        jumpBuffer = 0;
        p.dashTime = 0;
      }
    }
    if (pressed && input.dashPressed && p.dashCooldown <= 0) {
      p.dashTime = 0.15;
      p.dashCooldown = 0.65;
      p.vy = 0;
      p.vx = p.facing * 650;
    }
    const direction = Number(input.right) - Number(input.left);
    if (direction !== 0 && wallLock === 0 && p.dashTime === 0)
      p.facing = direction < 0 ? -1 : 1;
    if (p.dashTime > 0) {
      p.dashTime = Math.max(0, p.dashTime - dt);
      p.vy = 0;
    } else {
      if (wallLock === 0)
        p.vx = approach(
          p.vx,
          direction * 250,
          (direction === 0 ? 2100 : 1900) * dt,
        );
      if (!input.jumpHeld && p.vy < -220) p.vy = -220;
      p.vy = Math.min(850, p.vy + 1500 * dt);
      if (p.wallSide !== 0 && direction === p.wallSide && p.vy > 100)
        p.vy = 100;
    }
    const previousBottom = p.y + p.h;
    const canStep = p.grounded && p.vy >= 0;
    p.grounded = false;
    p.riding = null;
    moveX(p.vx * dt, null, canStep);
    moveY(p.vy * dt);
    for (const e of state.enemies) {
      if (!e.alive) continue;
      e.x += e.speed * e.facing * dt;
      if (e.x <= e.minX) {
        e.x = e.minX;
        e.facing = 1;
      } else if (e.x >= e.maxX) {
        e.x = e.maxX;
        e.facing = -1;
      }
      if (!overlaps(p, e)) continue;
      if (p.vy > 0 && previousBottom <= e.y + 8) {
        e.alive = false;
        p.y = e.y - p.h;
        p.vy = -380;
        p.jumpsUsed = 1;
        p.grounded = false;
      } else damage(p.x + p.w / 2 < e.x + e.w / 2 ? -1 : 1);
    }
    for (const spike of level.spikes)
      if (overlaps(p, spike) && p.invulnerable <= 0) {
        p.health--;
        die();
        break;
      }
    if (p.y > level.height + 100 && state.phase === "playing") {
      p.health--;
      die();
    }
    if (state.phase !== "playing") return false;
    for (const c of state.crystals)
      if (!c.collected && overlaps(p, c)) {
        c.collected = true;
        state.collected++;
      }
    for (const c of state.checkpoints)
      if (overlaps(p, c) && state.checkpointId !== c.id) {
        for (const other of state.checkpoints) other.active = false;
        c.active = true;
        state.checkpointId = c.id;
        p.health = 3;
        state.message = "Sky beacon lit";
      }
    if (overlaps(p, level.portal)) {
      state.phase = "complete";
      p.animation = "complete";
      p.vx = 0;
      p.vy = 0;
      p.dashTime = 0;
      state.message = "Skyway restored!";
      return true;
    }
    p.animation =
      p.invulnerable > 0 && wallLock > 0
        ? "hurt"
        : p.dashTime > 0
          ? "dash"
          : !p.grounded
            ? p.vy < 0
              ? "jump"
              : "fall"
            : Math.abs(p.vx) > 10
              ? "run"
              : "idle";
    return false;
  }
  return {
    state,
    level,
    restart,
    step(dt, input) {
      if (input.restartPressed) {
        restart();
        return;
      }
      if (state.phase === "complete" || !Number.isFinite(dt) || dt <= 0) return;
      let remaining = dt;
      let first = true;
      while (remaining > 1e-9) {
        const slice = Math.min(PHYSICS_DT, remaining);
        if (tick(slice, input, first)) break;
        first = false;
        remaining -= slice;
      }
    },
  };
}
