/**
 * Greenvale world — gameplay simulation core.
 *
 * Owns the `GameState`, movement + collision against an image-guided polygon
 * set, skills (heal / ice / fire), NPC proximity interactions, and a small
 * collect-three-herbs quest. There is no Pixi Application or ticker here;
 * the host drives time by calling `update(dt, movement)`.
 *
 * Coordinate convention: feet (x,y) of the hero — i.e. the point where the
 * hero stands on the ground. The character pivot (768,560) sits ~30 px
 * above the feet.
 */

import { ACTION_SECONDS, ATTACKS, HEIGHT, WIDTH } from './types.js';
import type { Attack, GameState, Movement, Skill, World } from './types.js';

/** Hero foot radius — used for circular collision against static colliders. */
const HERO_RADIUS = 14;
// Native 32-pose envelope: ±44px, 90px above feet, 8px below.
const VIEW_MARGIN_X = 48;
const VIEW_MARGIN_TOP = 98;

/** Maximum simulation step the world will accept (seconds). */
const MAX_DT = 0.05;

/** Walk / run speeds (feet px per second). */
const WALK_SPEED = 125;
const RUN_SPEED = 235;

/** Dash travels this far along facing during its strike window; colliders stop it early. */
const DASH_DISTANCE = 96;
const DASH_START = 0.04;
const DASH_END = 0.26;

/**
 * Shared constants — exported so the HUD module can read the same numbers
 * the simulation uses. Values match the HUD's own constants (HP_MAX=120,
 * MANA_MAX=50, costs {heal:8, ice:10, fire:10}, full cooldown window = 6s).
 */
export const HP_MAX = 120;
export const MANA_MAX = 50;
export const SKILL_COSTS: Readonly<Record<Skill, number>> = Object.freeze({ heal: 8, ice: 10, fire: 10 });
export const SKILL_COOLDOWNS: Readonly<Record<Skill, number>> = Object.freeze({
  heal: 4,
  ice: 2.4,
  fire: 3.2,
});
export const INTERACT_RADIUS = 68;

const HEAL_HP = 28;
const MANA_REGEN = 6; // per second, up to MANA_MAX; bounded
export const HERB_RADIUS = 22;

// ---------------------------------------------------------------------------
// Static positions: NPCs and herb pickups
// ---------------------------------------------------------------------------

export interface NpcDef {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly message: string;
}

/**
 * Native inhabitants of the village observed in the reference artboard.
 * Coordinates are hero feet positions an NPC stands on; each value was
 * re-checked against the image so the player can approach and press E
 * without being stopped by a colider.
 *
 * The elder is reachable only through the farmer — main explicitly
 * confirmed that game-authored inference.
 */
export const NPCS: readonly NpcDef[] = Object.freeze([
  Object.freeze({
    id: 'guard',
    name: 'Guard',
    x: 383,
    y: 473,
    message: 'Guard: "The bridge is rarely this quiet. Be careful crossing the river."',
  }),
  Object.freeze({
    id: 'farmer',
    name: 'Farmer',
    x: 315,
    y: 689,
    message:
      'Farmer: "The Village Elder sent word: come find me whenever you need."',
  }),
  Object.freeze({
    id: 'merchant',
    name: 'Merchant',
    x: 1281,
    y: 529,
    message: 'Merchant: "Fresh apples, fine cloth, and some rumors. What can I get you?"',
  }),
  Object.freeze({
    id: 'smith',
    name: 'Blacksmith',
    x: 1325,
    y: 882,
    message: 'Blacksmith: "The forge is still burning. Bring me ore and I will forge it for you."',
  }),
]);

/**
 * Three native healing-herb pickups, parked on walkable ground per the
 * corrected image scan (clear of all colliders).
 */
export interface HerbDef {
  readonly x: number;
  readonly y: number;
}

export const HERBS: readonly HerbDef[] = Object.freeze([
  Object.freeze({ x: 675, y: 445 }), // central path, north-east of fountain
  Object.freeze({ x: 420, y: 570 }), // farm lane, between fences
  Object.freeze({ x: 1060, y: 587 }), // smith approach, bridge lane
]);

// ---------------------------------------------------------------------------
// Walkable map + colliders (image-guided polygons on a 1536x1024 artboard)
// ---------------------------------------------------------------------------

/**
 * Coordinate convention: each rect is `[x, y, w, h]` where (x,y) is the
 * top-left corner of the SOLID (blocked) region in artboard feet coords.
 * All values match a fresh image scan; broad "strip" rectangles were
 * removed so the village routes stay connected.
 */
const BLOCKED_RECTS: ReadonlyArray<readonly [number, number, number, number]> = [
  // Outer frame so the hero never escapes the artboard.
  [-200, -200, 1536 + 400, 1],
  [-200, 1023, 1536 + 400, 1],
  [-200, -200, 1, 1024 + 400],
  [1535, -200, 1, 1024 + 400],

  // ---- Blue-roof house (top-left) ----
  // House body + chimney; to x=420, y=420.
  [60, 110, 360, 280],
  [80, 90, 200, 50],

  // ---- Angel fountain ----
  // Basin is an ellipse — represented by the BLOCKED_POLYGONS block below.
  // (No rect collider here: ring + 4 thin caps covers the shape.)

  // ---- Striped market stall ----
  // Physical base x 1170..1370, y 420..567.
  [1170, 420, 200, 147],
  // Awning over the counter (low so players can still approach at the front).
  [1185, 410, 170, 16],

  // ---- Smith forge (bottom-right) ----
  // Ground footprint below the roof; preserve the lane south of the market.
  [1250, 620, 286, 270],
  // Anvil/counter lip just inside the entrance (small, leaves the doorway open).
  [1262, 880, 60, 14],

  // Observed fence runs and the signpost footprint.
  [102, 492, 109, 40],
  [362, 527, 22, 162],
  [0, 651, 278, 41],
  [420, 401, 98, 42],
  [928, 234, 25, 31],

  // ---- Wooden dock (bottom-center) ----
  // Deck x 715..840, y 790..940 must be walkable; only the small side
  // rails block the hero from sliding off the side.
  [705, 790, 12, 150],
  [838, 790, 12, 150],

  // ---- River + waterfall (native observed shapes) ----
  // North river continues behind the bridge's rear rail up to its deck.
  [1090, 130, 170, 170],
  // Vertical bridge facade and south water are not a walkable deck.
  [1010, 350, 180, 180],
  // Lower falls + lake — left side, south of farm
  [0, 760, 380, 80],
  [0, 840, 380, 184],
  [380, 900, 320, 124],
];

const BRIDGE = {
  x1: 1010,
  y1: 300, // observed paving, not the rear rail/water opening
  x2: 1210,
  y2: 350, // paving ends before the facade and open water under the arch
};

/** Feet collide with source post bases; elevated wood belongs to depth occlusion. */
const BLOCKED_BRIDGE_POSTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1026, 301, 18, 6],
  [1024, 385, 18, 6],
  [1172, 301, 18, 6],
  [1185, 385, 18, 6],
];

/** Observed tree cluster trunks / crowns used as solid obstacles. */
const BLOCKED_TREE_RECTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [530, 636, 30, 40],
  [850, 340, 100, 120],
  [1040, 690, 120, 115],
];

/**
 * Polygon colliders for non-rectangular shapes. Each polygon is a closed
 * loop of [x,y] vertices in artboard feet coords.
 */
const BLOCKED_POLYGONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // Angel fountain basin ellipse: center (714, 254), rx 82, ry 50.
  ellipsePolygon(714, 254, 82, 50, 28),
  // Source-water and cliff footprints; the walkable dock is handled below.
  [[686, 845], [950, 803], [980, 835], [948, 892], [980, 954],
    [935, 1002], [958, 1024], [680, 1024]],
  [[0, 738], [365, 738], [443, 688], [500, 742], [666, 752],
    [686, 845], [680, 1024], [0, 1024]],
];

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, n: number): ReadonlyArray<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

function circleRectHit(cx: number, cy: number, r: number, rx: number, ry: number, rw: number, rh: number): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function pointInPolygon(px: number, py: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const xi = a[0];
    const yi = a[1];
    const xj = b[0];
    const yj = b[1];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

/**
 * Canonical initial state. `createWorld` and `reset()` both use this so
 * the returned object identity never changes — only the field values do.
 */
function freshState(): GameState {
  return {
    x: 768,
    y: 560,
    facing: 1, // 1 = right, -1 = left
    gait: 'idle',
    time: 0,
    night: 0,
    paused: false,
    hp: HP_MAX,
    mana: MANA_MAX,
    herbs: 0,
    elderTalked: false,
    message: 'Welcome to Greenvale. Press E to talk, 1/2/3 to cast skills.',
    cooldowns: { heal: 0, ice: 0, fire: 0 },
    collected: [false, false, false],
    action: null,
    actionTime: 0,
  };
}


// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createWorld(): World {
  const state = freshState();

  function pointInsideBridge(x: number, y: number): boolean {
    return (
      x >= BRIDGE.x1 &&
      x <= BRIDGE.x2 &&
      y >= BRIDGE.y1 &&
      y <= BRIDGE.y2
    );
  }

  function canStand(x: number, y: number): boolean {
    if (x < VIEW_MARGIN_X || y < VIEW_MARGIN_TOP || x > WIDTH - VIEW_MARGIN_X || y > HEIGHT - HERO_RADIUS) {
      return false;
    }
    if (x >= 732 && x <= 823 && y >= 790 && y <= 924) return true;
    for (const r of BLOCKED_BRIDGE_POSTS) {
      if (circleRectHit(x, y, HERO_RADIUS, r[0], r[1], r[2], r[3])) return false;
    }
    // Only observed deck paving bypasses the river colliders.
    if (!pointInsideBridge(x, y)) {
      for (const r of BLOCKED_RECTS) {
        if (circleRectHit(x, y, HERO_RADIUS, r[0], r[1], r[2], r[3])) return false;
      }
      for (const r of BLOCKED_TREE_RECTS) {
        if (circleRectHit(x, y, HERO_RADIUS, r[0], r[1], r[2], r[3])) return false;
      }
      for (const poly of BLOCKED_POLYGONS) {
        if (pointInPolygon(x, y, poly)) return false;
      }
    }
    return true;
  }

  function ensureValidSpawn(): void {
    if (!canStand(state.x, state.y)) throw new Error('Greenvale spawn point is blocked by an obstacle.');
  }

  ensureValidSpawn();

  function nearAnyNpc(x: number, y: number): NpcDef | null {
    let best: NpcDef | null = null;
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const n of NPCS) {
      const d = dist2(x, y, n.x, n.y);
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  function nearHerb(x: number, y: number): number {
    let best = -1;
    let bestD = HERB_RADIUS * HERB_RADIUS;
    for (let i = 0; i < HERBS.length; i++) {
      if (state.collected[i]) continue;
      const h = HERBS[i]!;
      const d = dist2(x, y, h.x, h.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function update(dt: number, movement: Movement): void {
    if (!Number.isFinite(dt) || dt < 0) return;
    const step = Math.min(dt, MAX_DT);

    if (!state.paused) {
      state.time += step;
      for (const k of Object.keys(state.cooldowns) as Skill[]) {
        if (state.cooldowns[k] > 0) state.cooldowns[k] = Math.max(0, state.cooldowns[k] - step);
      }
      if (state.mana < MANA_MAX) state.mana = Math.min(MANA_MAX, state.mana + MANA_REGEN * step);
    }

    if (state.paused) {
      // Pause: freeze the simulation. Leave gait, time, facing, and pose
      // exactly as they were at the moment of pausing — do NOT force idle.
      return;
    }

    if (state.action) {
      advanceAction(step);
      return;
    }

    let mx = movement.x;
    let my = movement.y;
    if (Number.isFinite(mx) && Number.isFinite(my)) {
      const m = Math.hypot(mx, my);
      if (m > 1) {
        mx /= m;
        my /= m;
      }
    } else {
      mx = 0;
      my = 0;
    }
    const speed = movement.run ? RUN_SPEED : WALK_SPEED;
    const wantedX = state.x + mx * speed * step;
    const wantedY = state.y + my * speed * step;

    // Swept substeps along the full vector so the hero can't tunnel through
    // a wall; axis-decomposed fallback so the hero slides along edges.
    const dx = wantedX - state.x;
    const dy = wantedY - state.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / (HERO_RADIUS * 0.5)));
    let cx = state.x;
    let cy = state.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = state.x + dx * t;
      const ny = state.y + dy * t;
      if (canStand(nx, ny)) {
        cx = nx;
        cy = ny;
        continue;
      }
      if (canStand(nx, cy)) cx = nx;
      else if (canStand(cx, ny)) cy = ny;
      break;
    }
    state.x = cx;
    state.y = cy;

    if (mx !== 0) state.facing = mx < 0 ? -1 : 1;
    state.gait = mx !== 0 || my !== 0 ? (movement.run ? 'run' : 'walk') : 'idle';

    // Spawn safety: only trigger if we're actually outside the playable area.
    if (!canStand(state.x, state.y)) {
      state.x = 768;
      state.y = 560;
      ensureValidSpawn();
    }
  }

  function advanceAction(step: number): void {
    const action = state.action!;
    const from = state.actionTime;
    const to = from + step;
    if (action === 'dash') {
      const moving = Math.min(to, DASH_END) - Math.max(from, DASH_START);
      if (moving > 0) dashBy((state.facing * DASH_DISTANCE * moving) / (DASH_END - DASH_START));
    }
    state.gait = 'idle';
    if (to >= ACTION_SECONDS[action]) {
      state.action = null;
      state.actionTime = 0;
    } else {
      state.actionTime = to;
    }
  }

  /** Straight swept dash; stops at the first blocked substep instead of sliding. */
  function dashBy(dx: number): void {
    const steps = Math.max(1, Math.ceil(Math.abs(dx) / (HERO_RADIUS * 0.5)));
    for (let i = 0; i < steps; i++) {
      const nx = state.x + dx / steps;
      if (!canStand(nx, state.y)) return;
      state.x = nx;
    }
  }

  function interact(): void {
    if (state.paused) return;
    // NPC interaction first — a player could be near both an NPC and an herb.
    const npc = nearAnyNpc(state.x, state.y);
    if (npc) {
      if (npc.id === 'farmer') {
        state.elderTalked = true;
        state.message =
          state.herbs >= 3
            ? 'Village Elder (via Farmer): "Thank you. Greenvale will not forget this."'
            : 'Village Elder (via Farmer): "Gather 3 healing herbs and return. The village needs you."';
        return;
      }
      state.message = npc.message;
      return;
    }
    // Herb pickup requires explicit E — main acceptance forbids automatic
    // collection. Player has to be within HERB_RADIUS and press the key.
    const herbIndex = nearHerb(state.x, state.y);
    if (herbIndex >= 0) {
      state.collected[herbIndex] = true;
      state.herbs += 1;
      state.message = `Picked up a herb (${state.herbs}/3).`;
      if (state.herbs >= 3 && !state.elderTalked) {
        state.message = 'Got all 3 herbs. Find the Farmer to meet the Village Elder.';
      }
      return;
    }
    state.message = 'No one nearby to interact with.';
  }

  function cast(skill: Skill): boolean {
    if (state.paused) return false;
    if (state.cooldowns[skill] > 0) return false;
    const cost = SKILL_COSTS[skill];
    if (state.mana < cost) return false;
    state.mana -= cost;
    if (skill === 'heal') state.hp = Math.min(HP_MAX, state.hp + HEAL_HP);
    state.cooldowns[skill] = SKILL_COOLDOWNS[skill];
    state.action = skill;
    state.actionTime = 0;
    return true;
  }

  function attack(action: Attack): boolean {
    if (state.paused) return false;
    state.action = action;
    state.actionTime = 0;
    state.message = `${ATTACKS[action].label}!`;
    return true;
  }

  function reset(): void {
    const fresh = freshState();
    state.x = fresh.x;
    state.y = fresh.y;
    state.facing = fresh.facing;
    state.gait = fresh.gait;
    state.time = fresh.time;
    state.night = fresh.night;
    state.paused = fresh.paused;
    state.hp = fresh.hp;
    state.mana = fresh.mana;
    state.herbs = fresh.herbs;
    state.elderTalked = fresh.elderTalked;
    state.message = fresh.message;
    state.cooldowns.heal = fresh.cooldowns.heal;
    state.cooldowns.ice = fresh.cooldowns.ice;
    state.cooldowns.fire = fresh.cooldowns.fire;
    state.collected[0] = fresh.collected[0]!;
    state.collected[1] = fresh.collected[1]!;
    state.collected[2] = fresh.collected[2]!;
    state.action = fresh.action;
    state.actionTime = fresh.actionTime;
    ensureValidSpawn();
  }

  return { state, update, interact, cast, attack, reset, canStand };
}
