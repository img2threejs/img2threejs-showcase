import { Container, Sprite, Texture, TextureSource } from 'pixi.js';

export interface PixelSkillVfx {
  readonly root: Container;
  cast(x: number, y: number, facing: number): void;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function pixel(value: number): number {
  return Math.round(value / 2) * 2;
}

// Textures are baked once. Native rect cells, nearest sampling, no blur/gradient.
export function pixelTexture(
  label: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`Unable to create pixel texture ${label}.`);
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  const source = TextureSource.from({ resource: canvas, label, scaleMode: 'nearest' });
  return new Texture({ source, label });
}

export function pixelGlyph(
  label: string,
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  cell = 2,
): Texture {
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  return pixelTexture(label, width * cell, rows.length * cell, (ctx) => {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y]!;
      for (let x = 0; x < row.length; x++) {
        const key = row[x]!;
        if (key === '.') continue;
        const color = palette[key];
        if (!color) throw new Error(`Missing color ${key} in ${label}.`);
        ctx.fillStyle = color;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  });
}

export function pixelSprite(texture: Texture, label: string): Sprite {
  const sprite = new Sprite({ texture, label, roundPixels: true });
  sprite.anchor.set(0.5);
  sprite.eventMode = 'none';
  return sprite;
}
