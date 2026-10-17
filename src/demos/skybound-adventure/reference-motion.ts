import { Container, Graphics, MeshPlane, Sprite, TilingSprite } from "pixi.js";
import type { Texture } from "pixi.js";
import type { ReferenceLayer } from "./reference-types";

export interface MaterialMotion {
  root: Container;
  update?: (time: number, strength: number) => void;
  dispose?: () => void;
  setLength?: (height: number) => void;
}

/** All geometry/effects are allocated once. The host supplies the only clock. */
export function createMaterialMotion(
  layer: ReferenceLayer,
  texture: Texture,
  flowTexture: Texture | undefined,
  phase: number,
): MaterialMotion {
  const root = new Container();
  const { w, h, motion } = layer;
  if (motion === "chain") {
    const links = new Sprite(texture);
    const clip = new Graphics().rect(0, 0, w, h).fill(0xffffff);
    root.addChild(links, clip);
    links.mask = clip;
    return {
      root,
      setLength(height) { clip.scale.y = Math.max(0, height) / h; },
    };
  }
  if (motion === "water") {
    if (!flowTexture) throw new Error(`Missing source flow tile: ${layer.id}`);
    const still = new Sprite(texture);
    const moving = new Container();
    const flow = new TilingSprite({ texture: flowTexture, width: w, height: h });
    flow.tileScale.set(w / flowTexture.width, 1);
    const silhouette = new Sprite(texture);
    const foam: Graphics[] = [];
    moving.addChild(flow);
    for (let i = 0; i < 8; i++) {
      const fleck = new Graphics().rect(0, 0, i % 2 ? 1 : 2, 4 + i % 3).fill(0xe5fcff);
      moving.addChild(fleck);
      foam.push(fleck);
    }
    root.addChild(still, moving, silhouette);
    moving.mask = silhouette;
    return {
      root,
      update(time, strength) {
        // Source still remains the material's base, not a duplicated scene.
        // Actual tile advection and masked foam provide continuous downward flow.
        moving.alpha = (1 - Math.exp(-time * 3)) * 0.68;
        flow.tilePosition.y = Math.round(time * (58 + phase % 19) * (0.7 + strength * 0.3)) % flowTexture.height;
        for (let i = 0; i < foam.length; i++) {
          const fleck = foam[i]!;
          fleck.x = Math.round(w * (0.18 + ((i * 0.173 + phase * 0.031) % 0.64)));
          fleck.y = Math.round(time * (69 + i * 4) + i * h / foam.length) % h;
          fleck.alpha = 0.4 + 0.2 * Math.sin(time * 3 + i);
        }
      },
    };
  }
  // The owl flies as one intact cutout; its owner supplies the translation.
  if (motion === "foliage" || motion === "flag" || (motion === "flying" && layer.id !== "flying:owl") || motion === "portal") {
    const portal = motion === "portal";
    const mesh = new MeshPlane({ texture, verticesX: portal ? 2 : 6, verticesY: portal ? 2 : 7 });
    mesh.autoResize = false;
    if (portal) root.addChild(new Sprite(texture));
    root.addChild(mesh);
    if (portal) {
      const interior = new Graphics().ellipse(w * 0.5, h * 0.55, w * 0.42, h * 0.40).fill(0xffffff);
      root.addChild(interior);
      mesh.mask = interior;
    }
    const geometry = mesh.geometry;
    const positions = geometry.positions;
    const baseline = portal ? positions : positions.slice();
    const uvs = geometry.uvs;
    const originalUvs = portal ? uvs.slice() : uvs;
    const positionBuffer = mesh.geometry.getAttribute("aPosition").buffer;
    const uvBuffer = mesh.geometry.getAttribute("aUV").buffer;
    return {
      root,
      dispose() { geometry.destroy(true); },
      update(time, strength) {
        if (portal) {
          // Uniform UV rotation is periodic and bounded at arbitrarily long
          // play times; a fixed inner mask leaves the source rim/stone rigid.
          const angle = time * 1.6 * (0.6 + strength * 0.4);
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          for (let i = 0; i < uvs.length; i += 2) {
            const x = originalUvs[i]! - 0.5;
            const y = originalUvs[i + 1]! - 0.5;
            uvs[i] = 0.5 + x * c - y * s;
            uvs[i + 1] = 0.5 + x * s + y * c;
          }
          uvBuffer.update();
          return;
        }
        for (let i = 0; i < positions.length; i += 2) {
          const x = baseline[i]!;
          const y = baseline[i + 1]!;
          const nx = x / Math.max(w, 1);
          const ny = y / Math.max(h, 1);
          if (motion === "flag") {
            const wave = Math.sin(time * 2.6 + ny * 6 + phase) - Math.sin(ny * 6 + phase);
            positions[i] = x + Math.round(wave * 3.5 * ny ** 1.4 * strength);
            positions[i + 1] = y + Math.round(wave * 0.7 * ny * strength);
          } else if (motion === "flying") {
            const wing = Math.abs(nx - 0.5) * 2;
            positions[i] = x;
            positions[i + 1] = y + Math.round((Math.sin(time * 11 + phase) - Math.sin(phase)) * wing * 4 * strength);
          } else {
            // The bottom/outer frame vertices remain attached; only leaf/grass
            // detail bends. Rigid stone and all collider geometry stay unchanged.
            const attached = Math.sin(nx * Math.PI) * (1 - ny);
            const wave = Math.sin(time * 2.1 + ny * 3 + phase) - Math.sin(ny * 3 + phase);
            positions[i] = x + Math.round(wave * attached * 2.5 * strength);
            positions[i + 1] = y + Math.round(wave * attached * 0.5 * strength);
          }
        }
        positionBuffer.update();
      },
    };
  }
  const sprite = new Sprite(texture);
  if (layer.id === "flying:owl") sprite.roundPixels = true;
  root.addChild(sprite);
  if (motion === "lantern") {
    sprite.pivot.set(w / 2, 0);
    sprite.position.set(w / 2, 0);
    const glow = new Graphics().ellipse(w / 2, h * 0.6, w * 1.15, h * 0.85).fill({ color: 0xffc45a, alpha: 0.13 });
    glow.blendMode = "add";
    root.addChildAt(glow, 0);
    return {
      root,
      update(time, strength) {
        sprite.rotation = (Math.sin(time * 1.7 + phase) - Math.sin(phase)) * 0.018 * strength;
        glow.alpha = 0.68 + 0.18 * Math.sin(time * 8 + phase) + 0.09 * Math.sin(time * 17 + phase);
        sprite.tint = Math.sin(time * 7 + phase) > -0.6 ? 0xffffff : 0xffefcf;
      },
    };
  }
  if (motion === "spikes") {
    const glint = new Graphics().rect(-1, 0, 2, Math.min(9, h)).fill({ color: 0xf2ffff, alpha: 0.65 });
    const mask = new Sprite(texture);
    const shine = new Container();
    shine.addChild(glint);
    root.addChild(shine, mask);
    shine.mask = mask;
    return {
      root,
      update(time, strength) {
        glint.position.set((time * 21 + phase * 17) % Math.max(w, 1), 3);
        glint.alpha = (0.4 + 0.35 * Math.sin(time * 3 + phase)) * strength;
      },
    };
  }
  return { root };
}
