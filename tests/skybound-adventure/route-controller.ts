import type { GameState, InputFrame, LevelDefinition } from "../../src/demos/skybound-adventure/contracts";

export interface TraversalView {
  state: GameState;
  level: LevelDefinition;
}
export type TraversalController = (view: TraversalView) => InputFrame;

/** Positions are player top-left coordinates, not collectible centers. */
export const TRAVERSAL_ROUTE = [
  // Garden and slime coins first; climb the waterfall shaft after the descent.
  { x: 215, y: 348, jump: true },
  { x: 320, y: 388, coin: "gem-01" },
  { x: 425, y: 423, coin: "gem-02" },
  { x: 485, y: 376, jump: true },
  { x: 520, y: 378, stand: true, precise: true },
  { x: 578, y: 358, jump: true, coin: "gem-03" },
  { x: 637, y: 450 },
  { x: 610, y: 472, coin: "gem-04" },
  { x: 640, y: 472, stand: true, precise: true },
  { x: 640, y: 310, jump: true, double: true, air: true },
  { x: 590, y: 358, stand: true, precise: true },
  { x: 610, y: 358, stand: true, precise: true },
  { x: 674, y: 180, jump: true, double: true, air: true, coin: "gem-05" },
  { x: 740, y: 131, jump: true, double: true, wall: true },
  { x: 810, y: 208, jump: true },
  { x: 930, y: 350, coin: "gem-06" },
  { x: 1080, y: 422, coin: "gem-07" },
  { x: 1125, y: 390, jump: true, coin: "gem-08", precise: true },
  // Clear the crate patrol, then traverse the actual lower ruin passage both ways.
  { x: 1165, y: 390, jump: true, double: true, defeat: "slime-crate", precise: true },
  { x: 1200, y: 422, stand: true, precise: true, nudge: true },
  { x: 1224, y: 472, stand: true },
  { x: 1290, y: 472, jump: true, defeat: "boar-low" },
  { x: 1400, y: 472 },
  // Brake over the torch shelf and lower step; collect both coins before returning.
  { x: 1505, y: 522 },
  { x: 1548, y: 493, jump: true, coin: "gem-12" },
  { x: 1582, y: 493, coin: "gem-13" },
  { x: 1505, y: 522 },
  { x: 1420, y: 472, jump: true },
  { x: 1235, y: 472 },
  { x: 1190, y: 422, jump: true, precise: true },
  { x: 1125, y: 390, jump: true, precise: true },
  // Climb the west column, drop left of the coping, then launch beyond its ceiling.
  { x: 1225, y: 273, jump: true, double: true, earlyDouble: true },
  { x: 1315, y: 216, jump: true },
  { x: 1263, y: 310 },
  { x: 1315, y: 346, coin: "gem-09" },
  { x: 1344, y: 346, stand: true, precise: true },
  { x: 1540, y: 383, jump: true, double: true, coin: "gem-10" },
  { x: 1597, y: 383, coin: "gem-11" },
  { x: 1795, y: 351, jump: true, double: true },
  { x: 1940, y: 351 },
] as const;

/** Read-only state conditions tolerate render frames spanning several physics ticks. */
export function createTraversalController(): TraversalController {
  let stage = 0;
  let launched = false;
  let lastTick = -1;
  let settledSince: number | null = null;
  let lastNudgeTime = -1;
  return ({ state }) => {
    const p = state.player;
    const input: InputFrame = {
      left: false, right: false, jumpPressed: false, jumpHeld: true,
      dashPressed: false, restartPressed: false,
    };
    if (state.tick < lastTick) { stage = 0; launched = false; settledSince = null; lastNudgeTime = -1; }
    lastTick = state.tick;
    if (state.phase !== "playing" || state.deaths > 0) return input;
    let goal = TRAVERSAL_ROUTE[stage]!;
    const requiredCoin = "coin" in goal ? goal.coin : null;
    const requiredEnemy = "defeat" in goal ? goal.defeat : null;
    // Require a short stable observation window so queued movement drains before launch.
    const settled = p.grounded && Math.abs(p.x - goal.x) < 3 && Math.abs(p.y - goal.y) < 3 && Math.abs(p.vx) < 30;
    if (!settled) settledSince = null;
    else settledSince ??= state.time;
    if (Math.abs(p.x - goal.x) < ("precise" in goal ? 3 : 12) && Math.abs(p.y - goal.y) < 14 &&
        (!("precise" in goal) || (settledSince !== null && state.time - settledSince >= 0.1)) &&
        (p.grounded || (!("jump" in goal) && !("stand" in goal)) || "air" in goal) &&
        (requiredCoin === null || state.crystals.some((coin) => coin.id === requiredCoin && coin.collected)) &&
        (requiredEnemy === null || !state.enemies.some((enemy) => enemy.id === requiredEnemy && enemy.alive))) {
      if (stage < TRAVERSAL_ROUTE.length - 1) { stage++; launched = false; settledSince = null; }
      goal = TRAVERSAL_ROUTE[stage]!;
    }
    const difference = goal.x - p.x;
    const stoppingDistance = p.vx * Math.abs(p.vx) / (2 * 2100);
    if (difference - stoppingDistance > 2) input.right = true;
    else if (difference - stoppingDistance < -2) input.left = true;
    // Coast before a precise foothold; delayed input must not reverse the
    // approach and drive the player back off the opposite edge.
    if ("precise" in goal) {
      const direction = Math.sign(difference);
      const closingSpeed = p.vx * direction;
      const brakingDistance = Math.max(0, closingSpeed) * 0.12 +
        Math.max(0, closingSpeed) ** 2 / (2 * 2100);
      // The narrow crate drop uses separated nudges only after landing.
      const approach = Math.abs(difference) > 3 && brakingDistance < Math.abs(difference) - 2 &&
        (!("nudge" in goal) || !p.grounded || Math.abs(difference) >= 20 || (Math.abs(p.vx) < 30 && state.time - lastNudgeTime >= 0.15));
      if (approach && p.grounded && Math.abs(difference) < 20) lastNudgeTime = state.time;
      input.left = approach && direction < 0;
      input.right = approach && direction > 0;
    }
    // A delayed release can leave a stand goal above the current floor.
    // Climb back with a normal jump instead of steering forever into its side.
    if ("stand" in goal && !p.grounded) launched = false;
    const patrol = "defeat" in goal ? goal.defeat : null;
    const patrolAlive = patrol !== null && state.enemies.some((enemy) => enemy.id === patrol && enemy.alive);
    if ("stand" in goal && !launched && p.grounded && p.y > goal.y + 14) {
      input.jumpPressed = true;
      launched = true;
    } else if ("jump" in goal && (!launched || patrolAlive) && p.grounded) {
      input.jumpPressed = true;
      launched = true;
    } else if ("double" in goal && launched && p.jumpsUsed === 1 &&
        p.vy > ("earlyDouble" in goal ? -200 : -65)) {
      input.jumpPressed = true;
    }
    if ("wall" in goal && p.wallSide !== 0 && p.vy > -65) {
      input.jumpPressed = true;
      launched = true;
    }
    // The lower corridor is a two-way crossing of the live boar patrol.
    // Jump on approach; normal stomp and damage rules remain in effect.
    if (p.grounded && p.y > 430 && p.x > 1200 && p.x < 1450) {
      const boar = state.enemies.find((enemy) => enemy.id === "boar-low" && enemy.alive);
      if (boar && (difference > 0
        ? boar.x > p.x && boar.x - p.x < 85
        : boar.x + boar.w < p.x + p.w && p.x - boar.x - boar.w < 65))
        input.jumpPressed = true;
    }
    return input;
  };
}
