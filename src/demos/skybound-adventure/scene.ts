import { Assets, Container, Graphics } from "pixi.js";
import type { Texture } from "pixi.js";
import manifest from "../../../public/skybound-adventure/reference-map/manifest.json" with { type: "json" };
import type { GameState, LevelDefinition, SceneHandle } from "./contracts";
import type { ReferenceLayer, ReferenceMapManifest } from "./reference-types";
import { createMaterialMotion } from "./reference-motion";
import type { MaterialMotion } from "./reference-motion";
import { createReferenceActor } from "./reference-actor";
import type { ReferenceActor } from "./reference-actor";

const ART = manifest as ReferenceMapManifest;
const textures: Record<string, Texture> = {};
let loading: Promise<void> | undefined;

/** Shared image sources are host-owned and survive scene disposal/remount. */
export function loadSceneAssets(): Promise<void> {
  if (loading) return loading;
  const urls: Record<string, true> = { [ART.player.texture]: true };
  for (const layer of ART.layers) {
    if (layer.motion !== "player") urls[layer.texture] = true;
    if (layer.flowTexture) urls[layer.flowTexture] = true;
  }
  loading = Promise.all(Object.keys(urls).map(async (url) => {
    textures[url] = await Assets.load<Texture>(url);
  })).then(() => undefined);
  return loading;
}

interface LayerNode {
  layer: ReferenceLayer;
  owner: Container;
  material: MaterialMotion;
  phase: number;
  index: number;
  sourceFacing: number;
}

/** Native source registration, one host renderer/ticker, no screenshot backdrop. */
export function createScene(level: LevelDefinition): SceneHandle {
  if (!textures[ART.player.texture]) throw new Error("Call loadSceneAssets before createScene.");
  const root = new Container();
  root.label = "skybound-scene";
  root.eventMode = "none";
  const owners: Record<string, Container> = {};
  const authored: Record<string, { x: number; y: number; visible: boolean }> = {};
  const own = (id: string, parent: Container, x = 0, y = 0) => {
    const owner = new Container();
    owner.label = id;
    owner.position.set(x, y);
    parent.addChild(owner);
    owners[id] = owner;
    authored[id] = { x, y, visible: true };
    return owner;
  };
  const world = own("world", root);
  const animated: LayerNode[] = [];
  let actor: ReferenceActor | undefined;
  let playerOwner: Container | undefined;
  let trail: Graphics | undefined;
  const moverIndexes: Record<string, number> = {};
  const moverVisualOffsetsY: number[] = [];
  const enemyVisualOffsets = new Float32Array(level.enemies.length * 2);
  let moverIndex = 0;
  for (const platform of level.platforms)
    if (platform.kind === "moving") moverIndexes[platform.id] = moverIndex++;

  for (let i = 0; i < ART.layers.length; i++) {
    const layer = ART.layers[i]!;
    const owner = own(layer.id, world, layer.x, layer.y);
    if (layer.motion === "player") {
      playerOwner = owner;
      actor = createReferenceActor(ART.player, textures[ART.player.texture]!);
      trail = new Graphics();
      for (let t = 1; t <= 4; t++)
        trail.rect(-t * 12 - 7, -35 + t * 3, 15, 24 - t * 3).fill({ color: 0xffd77a, alpha: 0.22 - t * 0.035 });
      owner.addChild(trail, actor.sprite);
      continue;
    }
    const texture = textures[layer.texture];
    if (!texture) throw new Error(`Required source layer not loaded: ${layer.texture}`);
    const material = createMaterialMotion(layer, texture, layer.flowTexture ? textures[layer.flowTexture] : undefined, i * 0.93);
    owner.addChild(material.root);
    if (layer.motion === "enemy" || layer.motion === "idle") {
      material.root.pivot.set(layer.w / 2, layer.h);
      material.root.position.set(layer.w / 2, layer.h);
    }
    const index = layer.motion === "enemy"
      ? level.enemies.findIndex((enemy) => enemy.id === layer.binding)
      : layer.motion === "crystal"
        ? level.crystals.findIndex((crystal) => crystal.id === layer.binding)
        : layer.motion === "mover" || layer.motion === "chain"
          ? moverIndexes[layer.binding!]
          : -1;
    if ((layer.motion === "enemy" || layer.motion === "crystal" || layer.motion === "mover" || layer.motion === "chain") && (index === undefined || index < 0))
      throw new Error(`Source layer has no physics binding: ${layer.id}`);
    if (layer.motion === "enemy") {
      // Matte trims must not move the native source art or its authored body.
      enemyVisualOffsets[index * 2] = layer.x - level.enemies[index]!.x;
      enemyVisualOffsets[index * 2 + 1] = layer.y - level.enemies[index]!.y;
    }
    if (layer.motion === "mover") {
      for (const platform of level.platforms) {
        if (platform.id !== layer.binding) continue;
        // A source fitting can extend above the actual standing surface.
        material.root.position.set(layer.x - platform.x, layer.y - platform.y);
        moverVisualOffsetsY[index] = layer.y - platform.y;
        break;
      }
    }
    if (layer.motion !== "still")
      animated.push({ layer, owner, material, phase: i * 0.93, index, sourceFacing: layer.motion === "enemy" ? level.enemies[index]!.facing : 1 });
  }
  if (!actor || !playerOwner || !trail) throw new Error("The source player atlas is required.");
  const playerActor = actor;
  const playerNode = playerOwner;
  const dashTrail = trail;
  const media = typeof window === "undefined" ? undefined : window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = media?.matches ?? false;
  const motionPreference = (event: MediaQueryListEvent) => { reducedMotion = event.matches; };
  media?.addEventListener("change", motionPreference);
  const overrides = new Map<string, { visible?: boolean; x?: number; y?: number }>();
  let disposed = false;
  let cameraX = 0;
  let cameraY = 0;
  let cameraScale = 1;
  let lastTick = -1;
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

  function update(state: GameState, dt: number, viewportWidth: number, viewportHeight: number) {
    if (disposed || viewportWidth <= 0 || viewportHeight <= 0) return;
    cameraScale = Math.max(0.35, viewportHeight / ART.height, viewportWidth / ART.width);
    const viewWidth = viewportWidth / cameraScale;
    const viewHeight = viewportHeight / cameraScale;
    if (state.tick < lastTick) cameraX = cameraY = 0;
    lastTick = state.tick;
    const maximumX = Math.max(0, level.width - viewWidth);
    const maximumY = Math.max(0, level.height - viewHeight);
    const targetX = clamp(state.player.x + state.player.w / 2 - viewWidth * 0.4, 0, maximumX);
    const targetY = clamp(state.player.y - viewHeight * 0.54, 0, maximumY);
    const smoothing = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * 6);
    cameraX = clamp(cameraX + (targetX - cameraX) * smoothing, 0, maximumX);
    cameraY = clamp(cameraY + (targetY - cameraY) * smoothing, 0, maximumY);
    root.scale.set(cameraScale);
    world.position.set(-cameraX, -cameraY);
    const time = state.time;
    const strength = reducedMotion ? 0.15 : 1;
    for (const node of animated) {
      const { layer, owner, material, phase, index } = node;
      switch (layer.motion) {
        case "cloud":
          owner.position.set(
            layer.x + (Math.sin(time * 0.45 + phase) - Math.sin(phase)) * 4 * strength,
            layer.y + (Math.sin(time * 0.31 + phase) - Math.sin(phase)) * strength,
          );
          break;
        case "airship":
          owner.position.set(
            layer.x + Math.sin(time * Math.PI / 9) * 10 * strength,
            layer.y + Math.sin(time * Math.PI / 6) * 2.5 * strength,
          );
          break;
        case "idle":
          material.root.scale.y = 1 + (Math.sin(time * 3.4 + phase) - Math.sin(phase)) * 0.0125 * strength;
          break;
        case "flying":
          owner.y = layer.y + (Math.sin(time * 2 + phase) - Math.sin(phase)) * 3.5 * strength;
          break;
        case "crystal": {
          const crystal = state.crystals[index]!;
          owner.visible = !crystal.collected;
          owner.y = layer.y + (Math.sin(time * 3 + phase) - Math.sin(phase)) * 1.5 * strength;
          break;
        }
        case "mover": {
          const mover = state.movers[index]!;
          owner.position.set(mover.x, mover.y);
          break;
        }
        case "chain": {
          const mover = state.movers[index]!;
          material.setLength!(mover.y + moverVisualOffsetsY[index]! - layer.y);
          break;
        }
        case "enemy": {
          const enemy = state.enemies[index]!;
          owner.visible = enemy.alive;
          owner.position.set(enemy.x + enemyVisualOffsets[index * 2]!, enemy.y + enemyVisualOffsets[index * 2 + 1]!);
          material.root.scale.set(enemy.facing / node.sourceFacing, 1 + (Math.sin(time * 11 + phase) - Math.sin(phase)) * 0.0175);
          break;
        }
      }
      // Don't upload offscreen decorative mesh buffers. Seeking back into view
      // evaluates the absolute state clock, never an accumulated local phase.
      if (material.update && owner.visible && owner.x + layer.w >= cameraX - 16 && owner.x <= cameraX + viewWidth + 16)
        material.update(time, strength);
    }
    const player = state.player;
    playerNode.position.set(player.x + player.w / 2, player.y + player.h);
    playerActor.update(state);
    dashTrail.visible = player.animation === "dash";
    dashTrail.scale.x = player.facing;
    for (const [id, transform] of overrides) {
      const owner = owners[id]!;
      if (transform.visible !== undefined) owner.visible = transform.visible;
      if (transform.x !== undefined) owner.x = transform.x;
      if (transform.y !== undefined) owner.y = transform.y;
    }
  }

  return {
    root,
    owners,
    update,
    getCamera() { return { x: cameraX, y: cameraY, scale: cameraScale }; },
    resetCamera() { cameraX = cameraY = 0; lastTick = -1; },
    setOwnerTransform(id, transform) {
      if (disposed) return;
      const owner = owners[id];
      if (!owner) throw new Error(`Unknown scene owner: ${id}`);
      if (transform.visible === undefined && transform.x === undefined && transform.y === undefined) {
        overrides.delete(id);
        const base = authored[id]!;
        owner.position.set(base.x, base.y);
        owner.visible = base.visible;
        return;
      }
      const current = overrides.get(id) ?? {};
      Object.assign(current, transform);
      overrides.set(id, current);
      if (transform.visible !== undefined) owner.visible = transform.visible;
      if (transform.x !== undefined) owner.x = transform.x;
      if (transform.y !== undefined) owner.y = transform.y;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      media?.removeEventListener("change", motionPreference);
      overrides.clear();
      root.destroy({ children: true, texture: false, textureSource: false });
      for (const node of animated) node.material.dispose?.();
      playerActor.dispose();
    },
  };
}
