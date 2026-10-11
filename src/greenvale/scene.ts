import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { createActors } from './actors.js';
import { createCharacter } from './character.js';
import { createEffects } from './effects.js';
import { createHud } from './hud.js';
import { createWorld, HERBS } from './world.js';
import { HEIGHT, WIDTH } from './types.js';
import type { Attack, Movement, Resources, Scene, Skill } from './types.js';

export function createScene(resources: Resources): Scene {
  const root = new Container({ label: 'greenvale', sortableChildren: true });
  root.hitArea = new Rectangle(0, 0, WIDTH, HEIGHT);
  const owners: Record<string, Container> = {};
  for (const layer of resources.environment.layers) {
    const owner = new Container({ label: layer.id });
    const sprite = new Sprite(resources.textures[layer.file]);
    owner.position.set(layer.x, layer.y);
    owner.zIndex = layer.id === 'terrain' ? -1000
      : layer.id === 'bridge' || layer.id === 'dock' ? -900 : layer.y + layer.height;
    owner.addChild(sprite);
    root.addChild(owner);
    owners[layer.id] = owner;
  }
  const actors = createActors(resources);
  for (const actor of resources.actors.actors) {
    root.addChild(actors.plates[actor.id]!, actors.nodes[actor.id]!);
    owners[`${actor.id}-plate`] = actors.plates[actor.id]!;
    owners[actor.id] = actors.nodes[actor.id]!;
  }
  root.addChild(actors.emissive);
  owners['actors-emissive'] = actors.emissive;
  const world = createWorld();
  const herbs = HERBS.map((point, i) => {
    const herb = new Graphics({ label: `herb-${i + 1}` })
      .ellipse(0, 6, 12, 4).fill({ color: 0x183c1d, alpha: 0.3 })
      .moveTo(0, 4).lineTo(0, -12).stroke({ color: 0x275e2b, width: 3 })
      .ellipse(-4, -5, 6, 3).fill(0x81cb45)
      .ellipse(4, -10, 6, 3).fill(0xb2df63)
      .rect(-2, -17, 4, 4).fill(0xf5e394);
    herb.position.set(point.x, point.y);
    herb.zIndex = point.y;
    root.addChild(herb);
    owners[`herb-${i + 1}`] = herb;
    return herb;
  });
  const shadow = new Graphics({ label: 'hero-ground-shadow' })
    .ellipse(0, 0, 24, 7).fill({ color: 0x1a281d, alpha: 0.3 });
  root.addChild(shadow);
  const character = createCharacter(resources);
  root.addChild(character.root);
  owners.hero = character.root;
  owners['hero-shadow'] = shadow;
  const night = new Graphics({ label: 'night-grade' })
    .rect(0, 0, WIDTH, HEIGHT).fill(0x0d183e);
  night.zIndex = 2000;
  root.addChild(night);
  const effects = createEffects();
  effects.root.zIndex = 2100;
  root.addChild(effects.root);
  owners.effects = effects.root;
  const hud = createHud(resources);
  hud.root.zIndex = 3000;
  root.addChild(hud.root);
  owners.hud = hud.root;
  let disposed = false;

  function apply(dt: number): void {
    character.update(world.state);
    actors.update(world.state);
    shadow.position.set(world.state.x, world.state.y + 1);
    character.root.zIndex = world.state.y;
    shadow.zIndex = world.state.y - 0.1;
    shadow.visible = character.root.visible;
    night.alpha = world.state.night * 0.64;
    for (let i = 0; i < herbs.length; i++) herbs[i]!.visible = !world.state.collected[i];
    effects.update(dt, world.state);
    hud.update(world.state);
  }

  const scene: Scene = {
    root, owners, world, character, effects, actors, hud,
    update(dt: number, movement: Movement) {
      if (disposed || !Number.isFinite(dt) || dt < 0) return;
      const delta = Math.min(dt, 0.05);
      world.update(delta, movement);
      apply(world.state.paused ? 0 : delta);
    },
    cast(skill: Skill) {
      if (disposed || !world.cast(skill)) return;
      effects.cast(skill, world.state.x, world.state.y - 30, world.state.facing);
      hud.update(world.state);
    },
    attack(action: Attack) {
      if (disposed || !world.attack(action)) return;
      effects.attack(action, world.state.x, world.state.y, world.state.facing);
      hud.update(world.state);
    },
    reset() {
      if (disposed) return;
      world.reset(); character.reset(); effects.reset(); actors.reset(); apply(0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      character.dispose(); effects.dispose(); actors.dispose(); hud.dispose();
      root.destroy({ children: true, texture: false, textureSource: false });
    },
  };
  apply(0);
  return scene;
}
