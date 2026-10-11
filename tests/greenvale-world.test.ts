import { describe, expect, it } from 'vitest';
import { createWorld, HERBS } from '../src/greenvale/world';

describe('Greenvale movement and interaction', () => {
  it('crosses bridge paving but cannot walk down its vertical facade into water', () => {
    const world = createWorld();
    expect(world.canStand(1112, 328)).toBe(true);
    expect(world.canStand(1112, 287)).toBe(false);
    expect(world.canStand(1112, 398)).toBe(false);
    world.state.x = 1112;
    world.state.y = 328;
    for (let i = 0; i < 40; i++) world.update(.05, { x: 0, y: 1, run: true });
    expect(world.state.y).toBeGreaterThan(328);
    expect(world.state.y).toBeLessThanOrEqual(350);
    expect(world.canStand(world.state.x, world.state.y)).toBe(true);
  });

  it('keeps the complete animated silhouette inside the left and top canvas edges', () => {
    const world = createWorld();
    world.state.x = 60;
    world.state.y = 500;
    expect(world.canStand(world.state.x, world.state.y)).toBe(true);
    for (let i = 0; i < 40; i++) world.update(.05, { x: -1, y: 0, run: true });
    expect(world.state.x).toBeGreaterThanOrEqual(48);
    expect(world.state.x).toBeLessThan(60);
    world.state.x = 768;
    world.state.y = 112;
    expect(world.canStand(world.state.x, world.state.y)).toBe(true);
    for (let i = 0; i < 40; i++) world.update(.05, { x: 0, y: -1, run: true });
    expect(world.state.y).toBeGreaterThanOrEqual(98);
    expect(world.state.y).toBeLessThan(112);
  });

  it('requires explicit interaction and collects a herb only once', () => {
    const world = createWorld(), herb = HERBS[0]!;
    world.state.x = herb.x;
    world.state.y = herb.y;
    for (let i = 0; i < 20; i++) world.update(.05, { x: 0, y: 0, run: false });
    expect(world.state.herbs).toBe(0);
    world.interact();
    expect(world.state.herbs).toBe(1);
    world.interact();
    expect(world.state.herbs).toBe(1);
  });

  it('locks movement during an attack and dashes along facing until blocked', () => {
    const world = createWorld();
    expect(world.attack('slash')).toBe(true);
    for (let i = 0; i < 4; i++) world.update(.05, { x: 1, y: 0, run: true });
    expect(world.state.x).toBe(768);
    expect(world.state.action).toBe('slash');
    for (let i = 0; i < 6; i++) world.update(.05, { x: 0, y: 0, run: false });
    expect(world.state.action).toBeNull();
    world.update(.05, { x: 1, y: 0, run: false });
    expect(world.state.x).toBeGreaterThan(768);

    world.reset();
    world.attack('dash');
    for (let i = 0; i < 20 && world.state.action; i++) world.update(.05, { x: -1, y: 0, run: false });
    expect(world.state.action).toBeNull();
    expect(world.state.x).toBeCloseTo(768 + 96, 5);

    // Only 32px of open ground lies left of (80, 480) before the canvas-edge margin.
    world.state.x = 80;
    world.state.y = 480;
    world.state.facing = -1;
    world.attack('dash');
    for (let i = 0; i < 20 && world.state.action; i++) world.update(.05, { x: 0, y: 0, run: false });
    expect(world.state.x).toBeGreaterThanOrEqual(48);
    expect(world.state.x).toBeLessThan(64);
    expect(world.canStand(world.state.x, world.state.y)).toBe(true);
  });
});
