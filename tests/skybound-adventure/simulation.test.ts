import assert from "node:assert/strict";
import test from "node:test";
import { NO_INPUT, PHYSICS_DT } from "../../src/demos/skybound-adventure/contracts";
import type { InputFrame, LevelDefinition, Simulation } from "../../src/demos/skybound-adventure/contracts";
import { createSimulation } from "../../src/demos/skybound-adventure/simulation";
import { LEVEL } from "../../src/demos/skybound-adventure/level";
import { runTraversal } from "./traversal";
import { createTraversalController } from "./route-controller";

function arena(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    name: "Physics fixture",
    width: 2000,
    height: 941,
    spawn: { x: 50, y: 258 },
    platforms: [{ id: "floor", kind: "solid", x: 0, y: 300, w: 1800, h: 80 }],
    enemies: [],
    crystals: [],
    spikes: [],
    checkpoints: [],
    portal: { x: 1900, y: 100, w: 30, h: 50 },
    ...overrides,
  };
}
function step(
  sim: Simulation,
  count = 1,
  input: Partial<InputFrame> = {},
): void {
  for (let i = 0; i < count; i++)
    sim.step(PHYSICS_DT, { ...NO_INPUT, ...input });
}
function until(
  sim: Simulation,
  predicate: () => boolean,
  input: Partial<InputFrame> = {},
  limit = 600,
): void {
  for (let i = 0; i < limit && !predicate(); i++) step(sim, 1, input);
  assert.ok(predicate(), "condition reached within bounded simulation time");
}

test("jump, double jump, third-jump rejection and landing reset", () => {
  const sim = createSimulation(arena());
  step(sim);
  assert.equal(sim.state.player.grounded, true);
  step(sim, 1, { jumpPressed: true, jumpHeld: true });
  assert.equal(sim.state.player.jumpsUsed, 1);
  assert.ok(sim.state.player.vy < -500);
  step(sim, 20, { jumpHeld: true });
  step(sim, 1, { jumpPressed: true, jumpHeld: true });
  assert.equal(sim.state.player.jumpsUsed, 2);
  const vy = sim.state.player.vy;
  step(sim, 1, { jumpPressed: true, jumpHeld: true });
  assert.ok(
    sim.state.player.vy > vy,
    "third press cannot reset upward velocity",
  );
  until(sim, () => sim.state.player.grounded, { jumpHeld: true });
  assert.equal(sim.state.player.jumpsUsed, 0);
});

test("dash has a duration, cooldown, and cannot tunnel through a thin wall", () => {
  const level = arena();
  level.platforms.push({
    id: "wall",
    kind: "solid",
    x: 115,
    y: 150,
    w: 3,
    h: 150,
  });
  const sim = createSimulation(level);
  step(sim);
  step(sim, 1, { dashPressed: true });
  assert.equal(sim.state.player.animation, "dash");
  sim.step(0.3, { ...NO_INPUT, dashPressed: true });
  assert.ok(sim.state.player.x + sim.state.player.w <= 115);
  assert.equal(sim.state.player.dashTime, 0);
  assert.ok(sim.state.player.dashCooldown > 0);
  step(sim, 1, { dashPressed: true });
  assert.equal(sim.state.player.dashTime, 0);
  step(sim, 60);
  step(sim, 1, { dashPressed: true });
  assert.ok(sim.state.player.dashCooldown > 0.6);
});

test("thin landing surfaces catch terminal-speed falls during a large step", () => {
  const sim = createSimulation(
    arena({
      spawn: { x: 50, y: 0 },
      platforms: [{ id: "thin", kind: "solid", x: 0, y: 700, w: 500, h: 2 }],
    }),
  );
  sim.step(1.5, NO_INPUT);
  assert.equal(sim.state.player.y, 658);
  assert.equal(sim.state.player.grounded, true);
});

// Reference-registered clear space, not the enclosing rectangles of the rocks.
for (const [name, x, y] of [
  ["starting waterfall below the wooden crossing", 213, 495],
  ["upper island tapered tip", 450, 340],
  ["upper west island tapered tip", 644, 246],
  ["left side of the upper bank", 692, 236],
  ["right side of the crown", 903, 310],
  ["right side of the left garden", 502, 512],
  ["right side of the slime island", 660, 544],
  ["right side of the lower garden", 350, 660],
  ["left side of the middle island", 889, 432],
  ["right side of the banner shelf", 1087, 510],
  ["bridge arch below its crown", 1605, 438],
  ["inside face of the bridge pier", 1704, 520],
  ["right side of the lower bridge island", 1652, 650],
] as const) {
  test(`full-sized player falls freely through ${name}`, () => {
    const sim = createSimulation(arena({
      ...LEVEL,
      spawn: { x, y },
      platforms: LEVEL.platforms.filter((platform) => platform.kind === "solid"),
      enemies: [], crystals: [], spikes: [], checkpoints: [],
    }));
    step(sim, 18);
    assert.equal(sim.state.player.x, x);
    assert.ok(Math.abs(sim.state.player.y - y - 17.8125) < 1e-6,
      `${name}: enclosing bounds must not act as solid terrain`);
    assert.equal(sim.state.player.grounded, false);
    assert.equal(sim.state.phase, "playing");
  });
}

test("the watchtower sky does not support the player or block the lower crystal", () => {
  for (const x of [1078, 1082, 1086, 1090, 1094]) {
    const sim = createSimulation({ ...LEVEL, spawn: { x, y: 348 } });
    until(sim, () => sim.state.player.y + sim.state.player.h >= 432 && sim.state.player.grounded);
    assert.equal(sim.state.player.x, x, "falling requires no escape input or horizontal ejection");
    assert.equal(sim.state.player.health, 3);
    assert.equal(sim.state.deaths, 0);
    assert.equal(sim.state.crystals.find(c => c.id === "gem-07")!.collected, true);
    assert.equal(sim.state.collected, 1);
  }
  const rock = createSimulation({ ...LEVEL, spawn: { x: 1015, y: 348 } });
  step(rock, 60);
  assert.equal(rock.state.player.grounded, true, "the actual neighboring rock remains solid");
  assert.ok(rock.state.player.y < 360);
  const postGap = createSimulation({ ...LEVEL, spawn: { x: 1056, y: 348 } });
  until(postGap, () => postGap.state.player.grounded && postGap.state.player.y > 400);
  assert.equal(postGap.state.player.x, 1056, "the decorative watch post is not a hidden rock wall");
  assert.equal(postGap.state.player.y + postGap.state.player.h, 464);
});

test("the left ruin approach enters the arch and collects the visible crystal exactly once", () => {
  const sim = createSimulation({ ...LEVEL, spawn: { x: 1230, y: 268 } });
  step(sim, 30);
  assert.equal(sim.state.player.grounded, true, "start on the independent left pillar");
  const crystal = sim.state.crystals.find(c => c.id === "gem-09")!;
  assert.equal(crystal.collected, false);
  until(sim, () => crystal.collected, { right: true }, 240);
  assert.ok(sim.state.player.x + sim.state.player.w >= 1318 && sim.state.player.x < 1342,
    "pickup must occur at the visible gold diamond, not in the left stone column");
  step(sim, 90);
  assert.equal(sim.state.player.grounded, true);
  assert.ok(sim.state.player.x >= 1300 && sim.state.player.x < 1350);
  assert.ok(sim.state.player.y + sim.state.player.h >= 380 &&
    sim.state.player.y + sim.state.player.h <= 392, "stand on the grass deck inside the opening");
  assert.equal(sim.state.player.health, 3);
  assert.equal(sim.state.deaths, 0);
  assert.equal(sim.state.collected, 1);
  step(sim, 20, { left: true });
  step(sim, 20, { right: true });
  assert.equal(sim.state.collected, 1, "re-entering the collected diamond cannot award it again");
});

test("the background arch frame leaves its coping and grass deck solid", () => {
  const roof = createSimulation({ ...LEVEL, spawn: { x: 1316, y: 200 } });
  step(roof, 90);
  assert.equal(roof.state.player.grounded, true);
  assert.ok(roof.state.player.y + roof.state.player.h >= 255 &&
    roof.state.player.y + roof.state.player.h <= 265, "the checkpoint roof remains standable");
  const deck = createSimulation({ ...LEVEL, spawn: { x: 1320, y: 310 } });
  step(deck, 90);
  assert.equal(deck.state.player.grounded, true);
  assert.ok(deck.state.player.y + deck.state.player.h >= 380 &&
    deck.state.player.y + deck.state.player.h <= 392, "the arch opening is not a hole through its floor");
  assert.equal(deck.state.deaths, 0);
  const walkway = createSimulation({
    ...LEVEL, spawn: { x: 1380, y: 330 }, enemies: [], spikes: [],
  });
  step(walkway, 90);
  assert.equal(walkway.state.player.grounded, true);
  assert.equal(walkway.state.player.y + walkway.state.player.h, 425,
    "the background right pier must not extend the high grass floor into air");
});

test("the crate edge opens into the lower ruin and western bridge passage without an escape jump", () => {
  const sim = createSimulation({
    ...LEVEL, spawn: { x: 1190, y: 422 }, enemies: [], spikes: [],
  });
  step(sim, 120, { right: true });
  assert.ok(sim.state.player.x > 1400, "neither hanging ruin nor western arch masonry seals the path");
  assert.equal(sim.state.player.y + sim.state.player.h, 514);
  assert.equal(sim.state.player.grounded, true);
  assert.equal(sim.state.player.wallSide, 0);
  assert.equal(sim.state.player.health, 3);
  assert.equal(sim.state.deaths, 0);
});

test("the lower bridge coins are entered from heartland with a normal jump and landing", () => {
  const sim = createSimulation({
    ...LEVEL, spawn: { x: 1400, y: 472 }, enemies: [], spikes: [],
  });
  until(sim, () => sim.state.player.grounded &&
    sim.state.player.y + sim.state.player.h === 564, { right: true }, 180);
  step(sim, 1, { right: true, jumpPressed: true, jumpHeld: true });
  until(sim, () => sim.state.player.x >= 1528, { right: true, jumpHeld: true }, 120);
  step(sim, 90);
  assert.equal(sim.state.player.grounded, true);
  assert.equal(sim.state.player.y + sim.state.player.h, 535);
  assert.equal(sim.state.crystals.find(c => c.id === "gem-12")!.collected, true);
  until(sim, () => sim.state.crystals.find(c => c.id === "gem-13")!.collected,
    { right: true }, 120);
  assert.equal(sim.state.collected, 2);
  assert.equal(sim.state.deaths, 0);
  assert.equal(sim.state.player.health, 3);
});

test("the short upper crate does not block the space above the wider lower crate", () => {
  const sim = createSimulation(arena({
    ...LEVEL, spawn: { x: 1184, y: 420 },
    enemies: [], crystals: [], spikes: [], checkpoints: [],
  }));
  step(sim, 30);
  assert.equal(sim.state.player.x, 1184);
  assert.equal(sim.state.player.y, 422);
  assert.equal(sim.state.player.grounded, true);
});

test("opening the bridge arch does not make its visible outer masonry passable", () => {
  const sim = createSimulation(arena({
    ...LEVEL, spawn: { x: 1844, y: 602 },
    enemies: [], crystals: [], spikes: [], checkpoints: [],
  }));
  step(sim, 1, { left: true });
  step(sim, 1, { left: true, dashPressed: true });
  step(sim, 5, { left: true });
  assert.ok(sim.state.player.x >= 1837, "dash cannot enter the visible stone pier");
  assert.equal(sim.state.player.wallSide, -1);
  assert.equal(sim.state.player.vx, 0);
  assert.equal(sim.state.player.dashTime, 0);
});

test("a passage accepts the actual player size, but rejects a smaller opening", () => {
  for (const width of [25.5, 26, 26.5]) {
    const sim = createSimulation(arena({
      spawn: { x: 100, y: 0 },
      platforms: [
        { id: "left", kind: "solid", x: 0, y: 100, w: 100, h: 600 },
        { id: "right", kind: "solid", x: 100 + width, y: 100, w: 100, h: 600 },
      ],
    }));
    step(sim, 60);
    assert.equal(sim.state.player.w, 26);
    assert.equal(sim.state.player.h, 42);
    if (width < 26) {
      assert.equal(sim.state.player.y, 58);
      assert.equal(sim.state.player.grounded, true);
    } else {
      assert.ok(sim.state.player.y > 100);
      assert.equal(sim.state.player.grounded, false);
    }
  }
  for (const height of [41.5, 42, 42.5]) {
    const level = arena();
    level.platforms.push({
      id: "roof", kind: "solid", x: 100, y: 0, w: 300, h: 300 - height,
    });
    const passage = createSimulation(level);
    step(passage, 90, { right: true });
    if (height < 42) assert.equal(passage.state.player.x, 74);
    else assert.ok(passage.state.player.x > 150);
  }
});

test("walking crosses native contour stairs, not real ledges or low ceilings", () => {
  for (const [rise, ceiling, pass] of [[2, false, true], [5, false, false], [2, true, false]] as const) {
    const level = arena();
    level.platforms.push({ id: "lip", kind: "solid", x: 100, y: 300 - rise, w: 60, h: rise });
    if (ceiling) level.platforms.push({ id: "roof", kind: "solid", x: 0, y: 200, w: 200, h: 58 });
    const sim = createSimulation(level);
    step(sim, 90, { right: true });
    if (pass) assert.ok(sim.state.player.x > 160, "small contour stairs remain walkable");
    else {
      assert.equal(sim.state.player.x, 74);
      assert.equal(sim.state.player.y, 258);
    }
  }
});

test("a lift crosses a compound body's empty opening without pausing or crushing", () => {
  const sim = createSimulation(arena({
    spawn: { x: 100, y: 258 },
    platforms: [
      { id: "lift", kind: "moving", x: 80, y: 300, w: 100, h: 20, travelY: -80, period: 2 },
      {
        id: "arch", kind: "solid", x: 0, y: 100, w: 250, h: 180,
        collisionRects: [
          { x: 0, y: 100, w: 30, h: 180 },
          { x: 230, y: 100, w: 20, h: 180 },
          { x: 0, y: 100, w: 250, h: 20 },
        ],
      },
    ],
  }));
  step(sim);
  step(sim, 119);
  assert.ok(Math.abs(sim.state.movers[0]!.y - 220) < 1e-6);
  assert.ok(Math.abs(sim.state.player.y - 178) < 1e-6);
  assert.equal(sim.state.player.riding, "lift");
  assert.equal(sim.state.player.health, 3);
  assert.equal(sim.state.deaths, 0);
});

test("the chain lift exit reaches the middle island with one jump and no damage", () => {
  for (let x = 850; x <= 890; x += 2) {
    const sim = createSimulation({ ...LEVEL, spawn: { x, y: 465 } });
    step(sim, 300);
    assert.equal(sim.state.player.riding, "chain-lift");
    let crossed = false;
    let landed = false;
    for (let frame = 0; frame < 240; frame++) {
      step(sim, 1, { right: !crossed, jumpHeld: true, jumpPressed: frame === 0 });
      const p = sim.state.player;
      assert.equal(p.health, 3, `lift exit damaged the player from x=${x}`);
      assert.equal(sim.state.deaths, 0);
      if (p.x >= 915 && p.y + p.h <= 392) crossed = true;
      if (crossed && p.grounded && Math.abs(p.y + p.h - 392) < 1e-6) {
        landed = true;
        break;
      }
    }
    assert.ok(landed, `one jump must land on the middle island from x=${x}`);
  }
});

test("jumping slides off shallow head corners, never through a roof or adjacent wall", () => {
  for (const [intrusion, obstacle, passes] of [
    [4, "none", true], [5, "none", false], [26, "none", false],
    [4, "side", false], [4, "above", false],
  ] as const) {
    const level = arena({ spawn: { x: 74 + intrusion, y: 258 } });
    level.platforms.push({ id: "roof", kind: "solid", x: 100, y: 100, w: 80, h: 100 });
    if (obstacle === "side")
      level.platforms.push({ id: "side", kind: "solid", x: 0, y: 200, w: 75, h: 100 });
    if (obstacle === "above")
      level.platforms.push({ id: "above", kind: "solid", x: 73, y: 90, w: 3, h: 110 });
    const sim = createSimulation(level);
    step(sim);
    let top = sim.state.player.y;
    for (let frame = 0; frame < 100; frame++) {
      step(sim, 1, { jumpHeld: true, jumpPressed: frame === 0 });
      const p = sim.state.player;
      top = Math.min(top, p.y);
      for (const solid of level.platforms)
        assert.ok(p.x + p.w <= solid.x || p.x >= solid.x + solid.w ||
          p.y + p.h <= solid.y || p.y >= solid.y + solid.h, `crossed ${solid.id}`);
    }
    assert.equal(top < 200, passes, `${intrusion}px corner with ${obstacle} obstruction`);
  }
  const mirrored = createSimulation(arena({
    spawn: { x: 176, y: 258 },
    platforms: [
      { id: "floor", kind: "solid", x: 0, y: 300, w: 1800, h: 80 },
      { id: "roof", kind: "solid", x: 100, y: 100, w: 80, h: 100 },
    ],
  }));
  step(mirrored);
  step(mirrored, 1, { jumpPressed: true, jumpHeld: true });
  step(mirrored, 35, { jumpHeld: true });
  assert.equal(mirrored.state.player.x, 180);
  assert.ok(mirrored.state.player.y < 200);
});

test("a head-bonking non-rider cannot be crushed by the next lift step", () => {
  const sim = createSimulation(arena({
    platforms: [
      { id: "lift", kind: "moving", x: 0, y: 300, w: 200, h: 30, travelY: -100, period: 4 },
      { id: "ceiling", kind: "solid", x: 0, y: 200, w: 200, h: 20 },
    ],
  }));
  step(sim, 720);
  step(sim, 1, { jumpPressed: true, jumpHeld: true });
  assert.equal(sim.state.player.riding, null, "the head bonk detaches the jumping rider");
  for (let frame = 0; frame < 720; frame++) {
    step(sim, 1, { jumpHeld: true });
    assert.ok(sim.state.player.y >= 220, "the whole ceiling stays solid");
    assert.equal(sim.state.player.health, 3);
    assert.equal(sim.state.deaths, 0);
  }
});

test("a horizontal carrier pauses instead of crushing a non-rider against a wall", () => {
  const level = arena();
  level.platforms.push(
    { id: "pusher", kind: "moving", x: 0, y: 240, w: 20, h: 50, travelX: 100, period: 2 },
    { id: "wall", kind: "solid", x: 100, y: 200, w: 40, h: 100 },
  );
  const sim = createSimulation(level);
  for (let frame = 0; frame < 360; frame++) {
    step(sim);
    assert.ok(sim.state.player.x + sim.state.player.w <= 100);
    assert.equal(sim.state.player.health, 3);
    assert.equal(sim.state.deaths, 0);
  }
  assert.ok(sim.state.player.x > level.spawn.x, "the carrier actually pushed the non-rider");
  assert.ok(sim.state.movers[0]!.x + sim.state.movers[0]!.w <= sim.state.player.x);
});

test("wall jump pushes away and resets the available air jump", () => {
  const sim = createSimulation(
    arena({
      spawn: { x: 74, y: 80 },
      platforms: [{ id: "wall", kind: "solid", x: 100, y: 0, w: 40, h: 600 }],
    }),
  );
  step(sim, 1, { right: true });
  assert.equal(sim.state.player.wallSide, 1);
  step(sim, 1, { right: true, jumpPressed: true, jumpHeld: true });
  assert.ok(sim.state.player.vx < -300);
  assert.ok(sim.state.player.vy < -500);
  assert.equal(sim.state.player.jumpsUsed, 1);
  step(sim, 5, { right: true, jumpHeld: true });
  assert.ok(sim.state.player.vx < 0, "wall lock resists input briefly");
});

function leaveEdge(): Simulation {
  const sim = createSimulation(
    arena({
      spawn: { x: 25, y: 258 },
      platforms: [{ id: "edge", kind: "solid", x: 0, y: 300, w: 80, h: 40 }],
    }),
  );
  step(sim);
  until(sim, () => !sim.state.player.grounded, { right: true, jumpHeld: true });
  return sim;
}
test("coyote grace accepts a late ground jump but expires", () => {
  const early = leaveEdge();
  step(early, 6, { right: true, jumpHeld: true });
  step(early, 1, { jumpPressed: true, jumpHeld: true });
  assert.equal(early.state.player.jumpsUsed, 1);
  assert.ok(early.state.player.vy < -500);
  const late = leaveEdge();
  step(late, 14, { right: true, jumpHeld: true });
  step(late, 1, { jumpPressed: true, jumpHeld: true });
  assert.equal(
    late.state.player.jumpsUsed,
    2,
    "expired coyote uses the single air jump",
  );
});

test("jump buffer survives landing within 130ms but expires before a later landing", () => {
  const buffered = createSimulation(arena());
  step(buffered);
  step(buffered, 1, { jumpPressed: true, jumpHeld: true });
  step(buffered, 1, { jumpPressed: true, jumpHeld: true });
  until(
    buffered,
    () => buffered.state.player.vy > 0 && buffered.state.player.y > 240,
    { jumpHeld: true },
  );
  step(buffered, 1, { jumpPressed: true, jumpHeld: true });
  until(
    buffered,
    () => buffered.state.player.vy < -500,
    { jumpHeld: true },
    20,
  );
  assert.equal(buffered.state.player.jumpsUsed, 1);
  const expired = createSimulation(arena());
  step(expired);
  step(expired, 1, { jumpPressed: true, jumpHeld: true });
  step(expired, 1, { jumpPressed: true, jumpHeld: true });
  until(expired, () => expired.state.player.vy >= 0, { jumpHeld: true });
  step(expired, 1, { jumpPressed: true, jumpHeld: true });
  until(expired, () => expired.state.player.grounded, { jumpHeld: true });
  step(expired, 3, { jumpHeld: true });
  assert.equal(expired.state.player.grounded, true);
});

test("moving platform carries its rider horizontally and vertically", () => {
  const sim = createSimulation(
    arena({
      platforms: [
        {
          id: "lift",
          kind: "moving",
          x: 0,
          y: 300,
          w: 200,
          h: 30,
          travelX: 90,
          travelY: -40,
          period: 4,
        },
      ],
    }),
  );
  step(sim);
  const relativeX = sim.state.player.x - sim.state.movers[0]!.x;
  step(sim, 120);
  const mover = sim.state.movers[0]!;
  assert.equal(sim.state.player.riding, "lift");
  assert.ok(Math.abs(sim.state.player.x - mover.x - relativeX) < 0.01);
  assert.ok(Math.abs(sim.state.player.y + sim.state.player.h - mover.y) < 0.01);
});

test("crystals are counted exactly once and definitions are never mutated", () => {
  const level = arena({
    crystals: [{ id: "gem", x: 55, y: 265, w: 20, h: 20, collected: false }],
  });
  const sim = createSimulation(level);
  step(sim, 20);
  assert.equal(sim.state.collected, 1);
  assert.equal(sim.state.crystals[0]!.collected, true);
  assert.equal(level.crystals[0]!.collected, false);
});

const enemy = {
  id: "enemy",
  x: 50,
  y: 270,
  w: 32,
  h: 30,
  minX: 50,
  maxX: 50,
  speed: 0,
  facing: 1 as const,
  alive: true,
};
test("falling onto an enemy stomps it and bounces without damage", () => {
  const sim = createSimulation(
    arena({ spawn: { x: 52, y: 130 }, enemies: [enemy] }),
  );
  until(sim, () => !sim.state.enemies[0]!.alive, { jumpHeld: true });
  assert.equal(sim.state.player.health, 3);
  assert.ok(sim.state.player.vy < 0);
});
test("side contact damages once and immunity protects subsequent contacts", () => {
  const sim = createSimulation(arena({ enemies: [enemy] }));
  step(sim);
  assert.equal(sim.state.player.health, 2);
  assert.ok(sim.state.player.invulnerable > 1);
  step(sim, 10, { right: true });
  assert.equal(sim.state.player.health, 2);
  assert.equal(sim.state.enemies[0]!.alive, true);
});

test("checkpoint, lethal fall, respawn health and full restart reset all state", () => {
  const sim = createSimulation(
    arena({
      platforms: [{ id: "small", kind: "solid", x: 0, y: 300, w: 160, h: 40 }],
      checkpoints: [
        {
          id: "beacon",
          x: 48,
          y: 240,
          w: 30,
          h: 60,
          spawnX: 50,
          spawnY: 258,
          active: false,
        },
      ],
      crystals: [{ id: "gem", x: 55, y: 265, w: 20, h: 20, collected: false }],
    }),
  );
  const initial = structuredClone(sim.state);
  step(sim);
  assert.equal(sim.state.checkpointId, "beacon");
  until(sim, () => sim.state.phase === "respawning", { right: true });
  assert.equal(sim.state.deaths, 1);
  assert.equal(sim.state.player.animation, "dead");
  until(sim, () => sim.state.phase === "playing");
  assert.equal(sim.state.player.x, 50);
  assert.equal(sim.state.player.y, 258);
  assert.ok(sim.state.player.invulnerable > 0);
  assert.equal(sim.state.collected, 1);
  step(sim, 1, { restartPressed: true });
  assert.deepEqual(sim.state, initial);
});

test("remaining hearts preserve checkpoint progress; the final fall starts a fresh run", () => {
  const sim = createSimulation(arena({
    spawn: { x: 50, y: 130 },
    platforms: [
      { id: "small", kind: "solid", x: 0, y: 300, w: 160, h: 40 },
      { id: "lift", kind: "moving", x: 400, y: 350, w: 80, h: 20,
        travelX: 30, period: 4 },
    ],
    enemies: [enemy],
    crystals: [{ id: "gem", x: 105, y: 265, w: 20, h: 20, collected: false }],
    checkpoints: [{
      id: "beacon", x: 100, y: 240, w: 30, h: 60,
      spawnX: 110, spawnY: 258, active: false,
    }],
  }));
  const initial = structuredClone(sim.state);
  until(sim, () => !sim.state.enemies[0]!.alive);
  until(sim, () => sim.state.player.x >= 100, { right: true });
  until(sim, () => sim.state.checkpointId === "beacon" && sim.state.collected === 1);
  for (let loss = 1; loss <= 3; loss++) {
    until(sim, () => sim.state.phase === "respawning", { right: true });
    assert.equal(sim.state.player.health, 3 - loss);
    assert.equal(sim.state.deaths, loss);
    assert.equal(sim.state.collected, 1);
    assert.equal(sim.state.enemies[0]!.alive, false);
    if (loss < 3) {
      until(sim, () => sim.state.phase === "playing");
      assert.equal(sim.state.player.health, 3 - loss, "respawning must not replenish remaining attempts");
      assert.equal(sim.state.checkpointId, "beacon");
      assert.equal(sim.state.collected, 1);
      assert.equal(sim.state.player.x, 110);
      assert.equal(sim.state.player.y, 258);
    } else {
      step(sim, 30);
      assert.equal(sim.state.phase, "respawning", "the last loss still plays the death animation");
      assert.equal(sim.state.player.health, 0);
      sim.step(1, { ...NO_INPUT, right: true });
    }
  }
  assert.deepEqual(sim.state, initial, "exhaustion resets the run, not just health: spawn, coins, enemies, checkpoint, movers and counters");
});

test("the final spike loss resets collected progress instead of granting unlimited retries", () => {
  const sim = createSimulation(arena({
    crystals: [{ id: "gem", x: 55, y: 265, w: 20, h: 20, collected: false }],
    spikes: [{ x: 150, y: 285, w: 30, h: 15 }],
  }));
  const initial = structuredClone(sim.state);
  for (let loss = 1; loss <= 3; loss++) {
    until(sim, () => sim.state.player.invulnerable === 0);
    until(sim, () => sim.state.phase === "respawning", { right: true });
    assert.equal(sim.state.player.health, 3 - loss);
    assert.equal(sim.state.collected, 1);
    if (loss < 3) until(sim, () => sim.state.phase === "playing");
    else sim.step(1, NO_INPUT);
  }
  assert.deepEqual(sim.state, initial);
});

test("exhausting hearts through enemy contact also starts a fresh run", () => {
  const sim = createSimulation(arena({
    platforms: [
      { id: "floor", kind: "solid", x: 0, y: 300, w: 400, h: 80 },
      { id: "ceiling", kind: "solid", x: 0, y: 200, w: 200, h: 55 },
      { id: "wall", kind: "solid", x: 90, y: 230, w: 20, h: 70 },
    ],
    enemies: [enemy],
    crystals: [{ id: "gem", x: 55, y: 265, w: 20, h: 20, collected: false }],
  }));
  const initial = structuredClone(sim.state);
  until(sim, () => sim.state.phase === "respawning", { right: true }, 900);
  assert.equal(sim.state.player.health, 0);
  assert.equal(sim.state.deaths, 1, "nonlethal enemy hits cost hearts without a checkpoint respawn");
  assert.equal(sim.state.collected, 1);
  assert.equal(sim.state.enemies[0]!.alive, true, "the fixture uses side damage, not a stomp");
  sim.step(1, NO_INPUT);
  assert.deepEqual(sim.state, initial);
});

test("completion freezes controls and world; restart remains available", () => {
  const sim = createSimulation(
    arena({ portal: { x: 45, y: 230, w: 60, h: 70 } }),
  );
  step(sim);
  assert.equal(sim.state.phase, "complete");
  const completed = structuredClone(sim.state);
  step(sim, 60, { right: true, jumpPressed: true, dashPressed: true });
  assert.deepEqual(sim.state, completed);
  step(sim, 1, { restartPressed: true });
  assert.equal(sim.state.phase, "playing");
  assert.equal(sim.state.time, 0);
});

test("identical fixed-step input streams produce identical state", () => {
  const a = createSimulation();
  const b = createSimulation();
  const control = createTraversalController();
  for (let i = 0; i < 600; i++) {
    const input = control(a);
    a.step(PHYSICS_DT, input);
    b.step(PHYSICS_DT, input);
  }
  assert.deepEqual(a.state, b.state);
});

test("authored level is completed using only input frames, without state mutation", () => {
  const { simulation, frames } = runTraversal();
  assert.equal(simulation.level, LEVEL);
  assert.equal(
    simulation.state.phase,
    "complete",
    `route stopped at ${simulation.state.player.x},${simulation.state.player.y} after ${frames} frames`,
  );
  assert.equal(
    simulation.state.deaths,
    0,
    "route does not rely on respawn skips",
  );
  assert.deepEqual(
    simulation.state.crystals.filter(c => c.collected).map(c => c.id).sort(),
    LEVEL.crystals.map(c => c.id).sort(),
    "portal completion must prove access to every coin, not only a four-coin shortcut",
  );
  assert.ok(
    simulation.state.player.x >= LEVEL.portal.x - simulation.state.player.w,
  );
});

for (const cadence of [2, 3, 4]) {
  test(`all coins remain reachable with ${cadence}-tick frames and four-tick input latency`, () => {
    const sim = createSimulation();
    const control = createTraversalController();
    const pending: { tick: number; input: InputFrame }[] = [];
    let input: InputFrame = { ...NO_INPUT };
    for (let tick = 0; tick < 7200 && sim.state.phase !== "complete"; tick++) {
      if (tick % cadence === 0) pending.push({ tick: tick + 4, input: control(sim) });
      if (pending[0]?.tick === tick) input = pending.shift()!.input;
      sim.step(PHYSICS_DT, input);
      input = { ...input, jumpPressed: false, dashPressed: false };
    }
    assert.equal(sim.state.phase, "complete");
    assert.equal(sim.state.deaths, 0);
    assert.deepEqual(
      sim.state.crystals.filter(c => c.collected).map(c => c.id).sort(),
      LEVEL.crystals.map(c => c.id).sort(),
    );
  });
}

test("the traversal climbs back after a late release drops it below a stand waypoint", () => {
  const sim = createSimulation();
  const control = createTraversalController();
  const onCrate = () => {
    const p = sim.state.player;
    return sim.state.collected === 8 && p.grounded &&
      p.y + p.h === 464 && p.x >= 1188 && p.x <= 1210;
  };
  for (let tick = 0; tick < 3000 && !onCrate(); tick++)
    step(sim, 1, control(sim));
  assert.ok(onCrate(), "normal spawn reaches the lower crate before the delayed release");
  step(sim, 36, { right: true });
  assert.ok(sim.state.player.x > 1215, "ordinary held input actually leaves the crate");
  for (let tick = 0; tick < 900 && !onCrate() && sim.state.deaths === 0; tick++)
    step(sim, 1, control(sim));
  assert.ok(onCrate(), "a normal jump returns to the higher waypoint, rather than steering into its side forever");
  assert.equal(sim.state.deaths, 0);
});

test("an obstructed rider pauses a lift without clipping or crushing", () => {
  const sim = createSimulation(
    arena({
      platforms: [
        {
          id: "lift",
          kind: "moving",
          x: 0,
          y: 300,
          w: 200,
          h: 30,
          travelY: -100,
          period: 4,
        },
        { id: "ceiling", kind: "solid", x: 0, y: 200, w: 200, h: 20 },
      ],
    }),
  );
  for (let frame = 0; frame < 720; frame++) {
    step(sim);
    assert.ok(sim.state.player.y >= 220, `rider crossed the ceiling at tick ${sim.state.tick}`);
  }
  assert.equal(sim.state.deaths, 0);
  assert.equal(sim.state.player.health, 3);
  assert.ok(sim.state.player.y >= 220);
  assert.ok(
    sim.state.player.y + sim.state.player.h <= sim.state.movers[0]!.y + 0.01,
  );
});

test("full restart restores authored movers, enemies, timers and deterministic replay", () => {
  const sim = createSimulation();
  const original = structuredClone(sim.state);
  const control = createTraversalController();
  for (let i = 0; i < 900; i++) sim.step(PHYSICS_DT, control(sim));
  sim.restart();
  assert.deepEqual(sim.state, original);
  const fresh = createSimulation();
  for (let i = 0; i < 180; i++) {
    const input = {
      ...NO_INPUT,
      right: true,
      jumpHeld: true,
      jumpPressed: i === 50,
      dashPressed: i === 90,
    };
    sim.step(PHYSICS_DT, input);
    fresh.step(PHYSICS_DT, input);
  }
  assert.deepEqual(sim.state, fresh.state);
});

test("horizontal input accelerates to a cap, brakes on release, and reverses", () => {
  const sim = createSimulation(arena());
  step(sim);
  step(sim, 1, { right: true });
  const initialSpeed = sim.state.player.vx;
  step(sim, 30, { right: true });
  const topSpeed = sim.state.player.vx;
  assert.ok(initialSpeed > 0 && topSpeed > initialSpeed);
  step(sim, 30, { right: true });
  assert.equal(
    sim.state.player.vx,
    topSpeed,
    "continued input cannot accelerate without bound",
  );
  const releaseX = sim.state.player.x;
  step(sim, 30);
  assert.equal(sim.state.player.vx, 0);
  assert.ok(
    sim.state.player.x > releaseX && sim.state.player.x < releaseX + 30,
    "release brakes rather than stopping instantly or drifting indefinitely",
  );
  step(sim, 20, { left: true });
  assert.ok(sim.state.player.vx < 0);
});

test("holding jump reaches higher than releasing early; ceiling collision stops ascent", () => {
  const full = createSimulation(arena());
  const short = createSimulation(arena());
  step(full);
  step(short);
  step(full, 1, { jumpPressed: true, jumpHeld: true });
  step(short, 1, { jumpPressed: true, jumpHeld: true });
  step(full, 30, { jumpHeld: true });
  step(short, 30);
  assert.ok(full.state.player.y < short.state.player.y - 30);
  const ceiling = arena();
  ceiling.platforms.push({
    id: "ceiling",
    kind: "solid",
    x: 0,
    y: 185,
    w: 300,
    h: 20,
  });
  const blocked = createSimulation(ceiling);
  step(blocked);
  step(blocked, 1, { jumpPressed: true, jumpHeld: true });
  until(blocked, () => blocked.state.player.vy >= 0, { jumpHeld: true });
  assert.ok(blocked.state.player.y >= 205, "head remains below solid ceiling");
});

test("spike contact loses a heart and respawns; temporary immunity permits a safe escape", () => {
  const sim = createSimulation(
    arena({ spikes: [{ x: 95, y: 282, w: 35, h: 18 }] }),
  );
  until(sim, () => sim.state.phase === "respawning", { right: true });
  assert.equal(sim.state.player.health, 2);
  assert.equal(sim.state.deaths, 1);
  until(sim, () => sim.state.phase === "playing");
  assert.equal(sim.state.player.x, 50);
  step(sim, 70, { right: true });
  assert.ok(
    sim.state.player.x > 130,
    "respawn immunity lets the player clear the hazard",
  );
  assert.equal(sim.state.deaths, 1);
  assert.equal(sim.state.player.health, 2);
});
