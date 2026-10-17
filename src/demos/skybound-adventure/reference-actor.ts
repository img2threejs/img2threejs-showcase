import { Rectangle, Sprite, Texture } from "pixi.js";
import type { GameState, PlayerAnimation } from "./contracts";
import type { ReferenceActorAtlas } from "./reference-types";

export interface ReferenceActor {
  sprite: Sprite;
  update(state: GameState): void;
  dispose(): void;
}

const FPS: Record<PlayerAnimation, number> = {
  idle: 5,
  run: 12,
  jump: 4,
  fall: 4,
  dash: 12,
  hurt: 8,
  dead: 6,
  complete: 7,
};

/** Per-scene frame views own no image source and never register a ticker. */
export function createReferenceActor(
  atlas: ReferenceActorAtlas,
  texture: Texture,
): ReferenceActor {
  const frames: Texture[] = [];
  let maximum = 0;
  for (const clip of Object.values(atlas.animations))
    for (const index of clip) maximum = Math.max(maximum, index);
  for (let index = 0; index <= maximum; index++) {
    frames.push(new Texture({
      source: texture.source,
      frame: new Rectangle(
        index % atlas.columns * atlas.frameWidth,
        Math.floor(index / atlas.columns) * atlas.frameHeight,
        atlas.frameWidth,
        atlas.frameHeight,
      ),
    }));
  }
  const sprite = new Sprite(frames[atlas.animations.idle[0]!]!);
  sprite.anchor.set(atlas.anchor.x / atlas.frameWidth, atlas.anchor.y / atlas.frameHeight);
  let disposed = false;
  return {
    sprite,
    update(state) {
      if (disposed) return;
      const player = state.player;
      const clip = atlas.animations[player.animation];
      const clock = player.animation === "dead" ? Math.max(0, 0.55 - state.respawnTime) : state.time;
      const index = Math.floor(clock * FPS[player.animation]);
      sprite.texture = frames[clip[player.animation === "dead" ? Math.min(index, clip.length - 1) : index % clip.length]!]!;
      sprite.scale.x = player.facing;
      sprite.tint = player.animation === "hurt" ? 0xffbbab : 0xffffff;
      sprite.alpha = player.invulnerable > 0 && Math.floor(state.time * 18) % 2 === 0 ? 0.45 : 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const frame of frames) frame.destroy(false);
    },
  };
}
