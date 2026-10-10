import { Container, Mesh, MeshGeometry, Rectangle, Texture } from 'pixi.js';
import type { CoffeeResources } from './contracts.js';

export const FOLIAGE_REGIONS: readonly (readonly [number, number, number, number])[] = [
  [180, 350, 90, 210], [1240, 830, 280, 185],
];

export interface FoliageHandle {
  readonly root: Container;
  readonly meshes: readonly Mesh<MeshGeometry>[];
  setAmbient(enabled: boolean): void;
  setTime(seconds: number, strength: number): void;
  dispose(): void;
}

const COLS = 12, ROWS = 14;
function smooth(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

export function createFoliage(resources: CoffeeResources): FoliageHandle {
  const backdrop = resources.motion.manifest.parts.find(p => p.id === 'backdrop');
  if (!backdrop) throw new Error('Missing coffee motion backdrop');
  const root = new Container({ label: 'coffee.foliage', eventMode: 'none', visible: false });
  const fields = FOLIAGE_REGIONS.map(([x, y, width, height], region) => {
    const texture = new Texture({ source: resources.motion.texture.source,
      frame: new Rectangle(backdrop.frame[0] + x, backdrop.frame[1] + y, width, height),
      label: `coffee.foliage.${region}` });
    const count = (COLS + 1) * (ROWS + 1), rest = new Float32Array(count * 2);
    const positions = new Float32Array(count * 2), uvs = new Float32Array(count * 2);
    const windX = new Float32Array(count), bendX = new Float32Array(count), bendY = new Float32Array(count);
    for (let row = 0; row <= ROWS; row++) for (let col = 0; col <= COLS; col++) {
      const i = row * (COLS + 1) + col, u = col / COLS, v = row / ROWS;
      rest[i * 2] = positions[i * 2] = u * width;
      rest[i * 2 + 1] = positions[i * 2 + 1] = v * height;
      uvs[i * 2] = u; uvs[i * 2 + 1] = v;
      const edge = smooth(Math.min(col, COLS - col) / 2) * smooth(Math.min(row, ROWS - row) / 2);
      // The left crop includes a lantern: suppress its side of the field.
      // Both regions remain contextual crops, not recovered individual leaf mattes.
      const anatomy = region === 0 ? smooth((u * width - 22) / 22) : 0.55 + 0.45 * u;
      const weight = edge * anatomy, amplitude = region === 0 ? 2 : 1.8;
      windX[i] = weight * amplitude * (0.3 + 0.7 * v);
      bendX[i] = weight * 0.45 * (u - 0.5);
      bendY[i] = weight * 0.55 * (1 - v);
    }
    const indices = new Uint32Array(COLS * ROWS * 6);
    let offset = 0;
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
      const a = row * (COLS + 1) + col, b = a + 1, c = a + COLS + 1, d = c + 1;
      indices[offset++] = a; indices[offset++] = b; indices[offset++] = c;
      indices[offset++] = b; indices[offset++] = d; indices[offset++] = c;
    }
    const geometry = new MeshGeometry({ positions, uvs, indices });
    const mesh = new Mesh({ geometry, texture, x, y, label: `coffee.foliage.mesh.${region}`, eventMode: 'none' });
    root.addChild(mesh);
    return { mesh, geometry, texture, rest, positions, windX, bendX, bendY, rate: (region === 0 ? 0.29 : 0.23) * Math.PI * 2 };
  });
  const meshes = fields.map(field => field.mesh);
  let ambient = false, disposed = false, time = 0, strength = 0;
  let appliedTime = -1, appliedStrength = -1;
  function apply(force = false): void {
    if (!force && ((strength === 0 && appliedStrength === 0) || (time === appliedTime && strength === appliedStrength))) return;
    for (const field of fields) {
      if (strength === 0) field.positions.set(field.rest);
      else {
        const wind = Math.sin(field.rate * time) * strength;
        const bend = Math.sin(field.rate * 0.57 * time) * strength;
        for (let i = 0; i < field.windX.length; i++) {
          field.positions[i * 2] = field.rest[i * 2]! + field.windX[i]! * wind + field.bendX[i]! * bend;
          field.positions[i * 2 + 1] = field.rest[i * 2 + 1]! + field.bendY[i]! * bend;
        }
      }
      field.geometry.positions = field.positions;
    }
    appliedTime = time; appliedStrength = strength;
  }
  return {
    root, meshes,
    setAmbient(enabled) {
      if (disposed) return;
      ambient = enabled; root.visible = enabled;
      if (ambient) apply(true);
    },
    setTime(seconds, amount) {
      if (disposed) return;
      time = Math.max(0, seconds); strength = Math.max(0, Math.min(2, amount));
      if (ambient) apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true; root.removeFromParent();
      root.destroy({ children: true, texture: false, textureSource: false });
      for (const field of fields) {
        field.geometry.destroy(true); field.texture.destroy(false);
      }
    },
  };
}
