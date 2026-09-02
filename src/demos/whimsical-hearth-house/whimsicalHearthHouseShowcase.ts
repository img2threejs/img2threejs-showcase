// Showcase wiring for the GENERATED whimsical-hearth-house factory: builds the
// model, attaches the demo-layer interactions and exposes them through the
// viewer's animationController contract (buttons in the demo page's animation
// panel, Stop/Reset included). The generated factory file is never edited —
// everything demo-specific lives here.
import * as THREE from 'three';
import { createWhimsicalHearthHouseModel } from './createWhimsicalHearthHouseModel';
import { attachHearthHouseInteractions } from './whimsicalHearthHouseInteractions';

type HearthHouseAction = 'cozy-idle' | 'open-house' | 'explode';

type ActionController = {
  actions: ReadonlyArray<{ id: HearthHouseAction; label: string; loop: boolean }>;
  readonly active: HearthHouseAction;
  play: (name: HearthHouseAction) => void;
  stop: () => void;
  update: (dt: number) => void;
  subscribe: (listener: (active: HearthHouseAction) => void) => () => void;
};

export function createWhimsicalHearthHouseShowcase(): THREE.Group {
  const group = createWhimsicalHearthHouseModel({ castShadow: true, receiveShadow: true });
  const interactions = attachHearthHouseInteractions(group);

  const listeners = new Set<(active: HearthHouseAction) => void>();
  let active: HearthHouseAction = 'cozy-idle';
  let explodeT = 0;
  const controller: ActionController = {
    actions: [
      { id: 'cozy-idle', label: 'Cozy idle', loop: true },
      { id: 'open-house', label: 'Open house', loop: true },
      { id: 'explode', label: 'Explode view', loop: true },
    ],
    get active() { return active; },
    play(name) {
      active = name;
      if (name === 'open-house') interactions.openDoor();
      else interactions.closeDoor();
      listeners.forEach((listener) => listener(active));
    },
    stop() {
      interactions.reset();
      explodeT = 0;
      this.play('cozy-idle');
    },
    update(dt) {
      const target = active === 'explode' ? 1 : 0;
      if (explodeT !== target) {
        const k = 1 - Math.pow(0.001, dt); // frame-rate-independent ease
        explodeT += (target - explodeT) * k;
        if (Math.abs(target - explodeT) < 0.002) explodeT = target;
        interactions.setExplode(explodeT);
      }
      // the smoke idle writes absolute positions from the assembled pose, so it
      // yields while the parts are separated
      if (explodeT < 0.05) interactions.tickIdle(dt);
    },
    subscribe(listener) {
      listeners.add(listener);
      // the viewer subscribes after autoplay and expects an immediate replay
      // so the status line and button highlight match what is already running
      listener(active);
      return () => listeners.delete(listener);
    },
  };

  const runtime = group.userData.sculptRuntime as Record<string, unknown>;
  runtime.animationController = controller;
  group.userData.tick = (dt: number) => controller.update(dt);
  group.userData.actions = controller.actions.map((action) => action.id);
  controller.play('cozy-idle');
  return group;
}

export function makeWhimsicalHearthHouseBackground(): THREE.CanvasTexture {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  // warm parchment ground matching the reference plate and the look-dev
  // render intent (background #E6DDD2)
  const g = ctx.createRadialGradient(S * 0.5, S * 0.44, S * 0.12, S * 0.5, S * 0.5, S * 0.74);
  g.addColorStop(0, '#efe7dc');
  g.addColorStop(0.6, '#e2d7c8');
  g.addColorStop(1, '#c3ad97');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
