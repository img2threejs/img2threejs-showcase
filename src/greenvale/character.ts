import { Container, Sprite } from 'pixi.js';
import { heroPoseAt } from './hero-poses.js';
import type { Character, GameState, Resources } from './types.js';

const JOINTS: Record<string, { x: number; y: number; body: boolean }> = {
  sword: { x: 749, y: 518, body: true },
  'leg-left': { x: 756, y: 542, body: false },
  'leg-right': { x: 782, y: 542, body: false },
  'arm-left': { x: 748, y: 528, body: true },
  'arm-right': { x: 788, y: 528, body: true },
  torso: { x: 768, y: 542, body: true },
  head: { x: 768, y: 520, body: true },
};

/** Grip-to-tip direction of the sheathed source sword (pivot at the grip). */
const BLADE_REST = Math.atan2(-33, -22);
/** Shoulder-to-grip length of the forward arm and hip-to-foot length of a leg, in px. */
const HAND = 17;
const LEG = 20;

export function createCharacter(resources: Resources): Character {
  const root = new Container({ label: 'hero' });
  const body = new Container({ label: 'hero-upper-body' });
  body.position.set(0, -18);
  const parts: Record<string, Container> = {};
  // Legs are below the torso; the upper-body hierarchy shares one hip anchor.
  for (const asset of resources.character.parts) {
    const joint = JOINTS[asset.id];
    const texture = resources.textures[asset.file];
    if (!joint || !texture) throw new Error(`Missing character layer ${asset.id}.`);
    const node = new Container({ label: `hero-${asset.id}` });
    const sprite = new Sprite(texture);
    sprite.position.set(asset.x - joint.x, asset.y - joint.y);
    node.addChild(sprite);
    node.position.set(joint.x - 768, joint.y - (joint.body ? 542 : 560));
    if (joint.body) body.addChild(node); else root.addChild(node);
    parts[asset.id] = node;
  }
  root.addChild(body);
  const leftLeg = parts['leg-left']!;
  const rightLeg = parts['leg-right']!;
  const leftArm = parts['arm-left']!;
  const rightArm = parts['arm-right']!;
  const sword = parts.sword!;
  const swordRest = { x: sword.x, y: sword.y };
  let disposed = false;

  function rest(): void {
    body.y = -18;
    sword.position.set(swordRest.x, swordRest.y);
    sword.rotation = 0;
    layerSword(false);
  }

  /** The sheathed sword sits behind the torso; a blade passing in front draws over it. */
  function layerSword(front: boolean): void {
    const index = front ? body.children.length - 1 : 0;
    if (body.getChildIndex(sword) !== index) body.setChildIndex(sword, index);
  }

  function neutral(): void {
    rest();
    body.rotation = 0;
    leftLeg.rotation = rightLeg.rotation = leftArm.rotation = rightArm.rotation = 0;
    leftLeg.y = rightLeg.y = -18;
  }

  function pose(state: GameState): void {
    const p = heroPoseAt(state.action!, state.actionTime);
    // Hip drops until the straighter leg stays planted; the wider leg's foot lifts.
    const hip = -18 + LEG * (1 - Math.cos(Math.min(p.stepF, p.stepB)));
    root.position.set(state.x + (p.rx ?? 0) * state.facing, state.y + (p.ry ?? 0));
    body.y = hip;
    body.rotation = p.lean;
    rightArm.rotation = -p.front;
    leftArm.rotation = p.back;
    rightLeg.rotation = -p.stepF;
    leftLeg.rotation = p.stepB;
    leftLeg.y = rightLeg.y = hip;
    if (p.blade === undefined) {
      sword.position.set(swordRest.x, swordRest.y);
      sword.rotation = 0;
    } else if (p.grip === 'back') {
      sword.position.set(leftArm.x - HAND * Math.sin(p.back), leftArm.y + HAND * Math.cos(p.back));
      sword.rotation = p.blade - BLADE_REST;
    } else {
      sword.position.set(rightArm.x + HAND * Math.sin(p.front), rightArm.y + HAND * Math.cos(p.front));
      sword.rotation = p.blade - BLADE_REST;
    }
    layerSword(p.bladeFront === true);
  }

  return {
    root, parts,
    update(state: GameState) {
      if (disposed) return;
      root.position.set(state.x, state.y);
      root.scale.x = state.facing < 0 ? -1 : 1;
      if (state.action) { pose(state); return; }
      if (state.gait === 'idle') { neutral(); return; }
      rest();
      const running = state.gait === 'run';
      const phase = state.time * Math.PI * 2 * (running ? 3.2 : 1.85);
      const swing = Math.sin(phase);
      const legAngle = swing * (running ? 0.48 : 0.3);
      const armAngle = swing * (running ? 0.38 : 0.23);
      body.rotation = swing * (running ? 0.04 : 0.025);
      leftLeg.rotation = legAngle;
      rightLeg.rotation = -legAngle;
      // Correct the stance arc to keep a foot planted; only the swing foot lifts.
      const arc = 20 * (1 - Math.cos(legAngle));
      const lift = running ? 4 : 2.5;
      leftLeg.y = -18 + arc - Math.max(0, swing) * lift;
      rightLeg.y = -18 + arc - Math.max(0, -swing) * lift;
      leftArm.rotation = -armAngle;
      rightArm.rotation = armAngle;
    },
    reset() {
      if (disposed) return;
      neutral(); root.scale.x = 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.destroy({ children: true, texture: false, textureSource: false });
    },
  };
}
