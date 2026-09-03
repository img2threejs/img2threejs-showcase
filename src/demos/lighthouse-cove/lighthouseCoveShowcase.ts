// Showcase wiring for the GENERATED lighthouse-cove factory: builds the model,
// attaches the demo-layer interactions and exposes them through the viewer's
// animationController contract. The generated factory file is never edited.
import * as THREE from 'three';
import { createLighthouseCoveModel } from './createLighthouseCoveModel';
import { attachLighthouseCoveInteractions } from './lighthouseCoveInteractions';

type CoveAction = 'cove-idle' | 'open-cottage' | 'explode';

type ActionController = {
  actions: ReadonlyArray<{ id: CoveAction; label: string; loop: boolean }>;
  readonly active: CoveAction;
  play: (name: CoveAction) => void;
  stop: () => void;
  update: (dt: number) => void;
  subscribe: (listener: (active: CoveAction) => void) => () => void;
};

export function createLighthouseCoveShowcase(): THREE.Group {
  const group = createLighthouseCoveModel({ castShadow: true, receiveShadow: true });
  const interactions = attachLighthouseCoveInteractions(group);

  const listeners = new Set<(active: CoveAction) => void>();
  let active: CoveAction = 'cove-idle';
  let explodeT = 0;
  const controller: ActionController = {
    actions: [
      { id: 'cove-idle', label: 'Cove idle', loop: true },
      { id: 'open-cottage', label: 'Open cottage', loop: true },
      { id: 'explode', label: 'Explode view', loop: true },
    ],
    get active() { return active; },
    play(name) {
      active = name;
      if (name === 'open-cottage') interactions.openDoor();
      else interactions.closeDoor();
      listeners.forEach((listener) => listener(active));
    },
    stop() {
      interactions.reset();
      explodeT = 0;
      this.play('cove-idle');
    },
    update(dt) {
      const target = active === 'explode' ? 1 : 0;
      if (explodeT !== target) {
        const k = 1 - Math.pow(0.001, dt);
        explodeT += (target - explodeT) * k;
        if (Math.abs(target - explodeT) < 0.002) explodeT = target;
        interactions.setExplode(explodeT);
      }
      if (explodeT < 0.05) interactions.tickIdle(dt);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };

  const runtime = group.userData.sculptRuntime as Record<string, unknown>;
  runtime.animationController = controller;
  group.userData.tick = (dt: number) => controller.update(dt);
  group.userData.actions = controller.actions.map((action) => action.id);
  controller.play('cove-idle');
  return group;
}

export function makeLighthouseCoveBackground(): THREE.CanvasTexture {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  // warm sunset-tinted plate matching the reference and the render intent (#F4EBDE)
  const g = ctx.createRadialGradient(S * 0.5, S * 0.42, S * 0.12, S * 0.5, S * 0.5, S * 0.76);
  g.addColorStop(0, '#f7efe3');
  g.addColorStop(0.6, '#eadfcf');
  g.addColorStop(1, '#c9b49c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
