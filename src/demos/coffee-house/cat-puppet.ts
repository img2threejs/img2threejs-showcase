// Original painted body stays rigid. Only the separately matted source tail moves.
import { Container, Mesh, MeshGeometry, Sprite, Texture } from 'pixi.js';

export interface CatPuppetParts {
  readonly body: Sprite;
  readonly tail: Mesh<MeshGeometry>;
}
export interface CatPuppetHandle {
  readonly root: Container;
  readonly parts: CatPuppetParts;
  setTime(seconds: number): void;
  setStrength(value: number): void;
  dispose(): void;
}
export interface CatPuppetTextures { readonly body: Texture; readonly tail: Texture; }

const WIDTH = 112, HEIGHT = 128, TAU = Math.PI * 2;
// Detail only around the painted tail; the source attachment at x=47 is fixed.
const XS = [0, 15, 23, 31, 39, 47, 55, WIDTH];
const YS = [0, 80, 88, 96, 106, HEIGHT];

export function createCatPuppet(textures: CatPuppetTextures): CatPuppetHandle {
  const count = XS.length * YS.length;
  const rest = new Float32Array(count * 2), positions = new Float32Array(rest.length);
  const uvs = new Float32Array(rest.length), weights = new Float32Array(count);
  const indices = new Uint32Array((XS.length - 1) * (YS.length - 1) * 6);
  for (let row = 0; row < YS.length; row++) for (let col = 0; col < XS.length; col++) {
    const i = row * XS.length + col, x = XS[col]!, y = YS[row]!;
    rest[i * 2] = positions[i * 2] = x;
    rest[i * 2 + 1] = positions[i * 2 + 1] = y;
    uvs[i * 2] = x / WIDTH; uvs[i * 2 + 1] = y / HEIGHT;
    weights[i] = Math.max(0, Math.min(1, (47 - x) / 30));
  }
  let k = 0;
  for (let row = 0; row < YS.length - 1; row++) for (let col = 0; col < XS.length - 1; col++) {
    const a = row * XS.length + col, b = a + 1, c = a + XS.length, d = c + 1;
    indices[k++] = a; indices[k++] = b; indices[k++] = c;
    indices[k++] = b; indices[k++] = d; indices[k++] = c;
  }
  const geometry = new MeshGeometry({ positions, uvs, indices });
  const root = new Container({ label: 'coffee-cat-puppet', eventMode: 'none' });
  const body = new Sprite({ texture: textures.body, label: 'cat-source-body', eventMode: 'none' });
  const tail = new Mesh({ geometry, texture: textures.tail, label: 'cat-source-tail', eventMode: 'none' });
  root.addChild(tail, body);
  let time = 0, strength = 1, disposed = false;

  const apply = (): void => {
    const dx = strength * 1.5 * Math.sin(TAU * time / 8);
    const dy = strength * 2 * Math.sin(TAU * time / 4);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = rest[i * 2]! + weights[i]! * dx;
      positions[i * 2 + 1] = rest[i * 2 + 1]! + weights[i]! * dy;
    }
    geometry.positions = positions;
  };
  return {
    root, parts: { body, tail },
    setTime(seconds) {
      if (disposed) return;
      time = Math.max(0, seconds);
      if (strength > 0) apply();
    },
    setStrength(value) {
      if (disposed) return;
      const next = Math.max(0, Math.min(1, value));
      if (next === strength) return;
      strength = next; apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true; root.removeFromParent(); geometry.destroy(true);
      root.destroy({ children: true, texture: false, textureSource: false });
    },
  };
}
