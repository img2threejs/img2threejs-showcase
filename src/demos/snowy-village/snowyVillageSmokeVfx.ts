import * as THREE from 'three';

export interface SnowyVillageSmokeOptions {
  particleCount: number;
  lifetime: readonly [number, number];
  riseSpeed: readonly [number, number];
  spread: number;
  size: readonly [number, number];
  opacity: number;
  color: number;
}

export interface SnowyVillageSmokeVfx {
  update(delta: number, elapsed: number, opacityScale?: number): void;
  dispose(): void;
}

const TAU = Math.PI * 2;

function createSmokeTexture(): THREE.CanvasTexture {
  const side = 128;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext('2d');
  if (context) {
    const image = context.createImageData(side, side);
    const seed = Math.random() * 4096;
    const hash = (x: number, y: number): number => {
      const value = Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453123;
      return value - Math.floor(value);
    };
    const smooth = (value: number): number => value * value * (3 - 2 * value);
    const valueNoise = (x: number, y: number, cell: number): number => {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * tx;
      const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * tx;
      return top + (bottom - top) * ty;
    };

    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const nx = ((x + 0.5) / side) * 2 - 1;
        const ny = ((y + 0.5) / side) * 2 - 1;
        const noise = valueNoise(x, y, 28) * 0.48
          + valueNoise(x + 31, y - 17, 13) * 0.34
          + valueNoise(x - 11, y + 43, 6) * 0.18;
        const radius = Math.sqrt(nx * nx * 0.7 + ny * ny * 0.56) + (noise - 0.5) * 0.22;
        const edgeT = Math.max(0, Math.min(1, (radius - 0.48) / 0.58));
        const edgeFade = 1 - smooth(edgeT);
        const alpha = Math.max(0, Math.min(1, edgeFade * (0.08 + noise * 0.92)));
        const offset = (y * side + x) * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = Math.round(alpha * 255);
      }
    }
    context.putImageData(image, 0, 0);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createSnowyVillageSmokeVfx(
  parent: THREE.Object3D,
  origin: THREE.Vector3,
  options: SnowyVillageSmokeOptions,
): SnowyVillageSmokeVfx {
  const count = Math.max(1, Math.floor(options.particleCount));
  const texture = createSmokeTexture();
  const emitter = new THREE.Group();
  emitter.name = 'smoke billow emitter';
  emitter.position.copy(origin);
  const parentScale = Math.abs(parent.scale.x);
  if (parentScale > 0) emitter.scale.setScalar(1 / parentScale);
  parent.add(emitter);

  const sprites: THREE.Sprite[] = [];
  const materials: THREE.SpriteMaterial[] = [];
  const ages = new Float32Array(count);
  const lifetimes = new Float32Array(count);
  const startX = new Float32Array(count);
  const startZ = new Float32Array(count);
  const driftX = new Float32Array(count);
  const driftZ = new Float32Array(count);
  const riseSpeeds = new Float32Array(count);
  const phases = new Float32Array(count);

  const randomBetween = (range: readonly [number, number]): number =>
    range[0] + Math.random() * (range[1] - range[0]);
  const resetParticle = (index: number, stagger: boolean): void => {
    const lifetime = randomBetween(options.lifetime);
    lifetimes[index] = lifetime;
    ages[index] = stagger ? Math.random() * lifetime : 0;
    startX[index] = (Math.random() - 0.5) * options.spread * 0.12;
    startZ[index] = (Math.random() - 0.5) * options.spread * 0.12;
    const angle = Math.random() * TAU;
    const travel = Math.random() * options.spread * 0.8;
    driftX[index] = Math.cos(angle) * travel / lifetime;
    driftZ[index] = Math.sin(angle) * travel / lifetime;
    riseSpeeds[index] = randomBetween(options.riseSpeed);
    phases[index] = Math.random() * TAU;
  };

  for (let index = 0; index < count; index += 1) {
    resetParticle(index, true);
    const material = new THREE.SpriteMaterial({
      color: options.color,
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = 'smoke billow';
    sprite.renderOrder = 25;
    emitter.add(sprite);
    materials.push(material);
    sprites.push(sprite);
  }

  let disposed = false;
  const update = (delta: number, elapsed: number, opacityScale = 1): void => {
    if (disposed) return;
    const dt = Math.min(0.05, Math.max(0, delta));
    const strength = THREE.MathUtils.clamp(opacityScale, 0, 1);
    const sizeRange = options.size[1] - options.size[0];

    for (let index = 0; index < count; index += 1) {
      let age = ages[index] + dt;
      if (age >= lifetimes[index]) {
        resetParticle(index, false);
        age = 0;
      }
      ages[index] = age;
      const life = age / lifetimes[index];
      const swell = 0.65 + life * 0.75;
      const sway = Math.sin(elapsed * 0.55 + phases[index]) * options.spread * 0.035 * life;
      const sprite = sprites[index];
      sprite.position.set(
        startX[index] + driftX[index] * age + sway,
        riseSpeeds[index] * age,
        startZ[index] + driftZ[index] * age
          + Math.cos(elapsed * 0.42 + phases[index]) * options.spread * 0.035 * life,
      );
      const size = (options.size[0] + sizeRange * life) * swell;
      sprite.scale.set(size * 0.9, size * 1.35, 1);
      sprite.material.rotation = phases[index] + elapsed * 0.07;
      sprite.material.opacity = options.opacity * strength * Math.sin(Math.PI * life) * (1 - life * 0.25);
    }
  };
  update(0, 0, 1);

  return {
    update,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      parent.remove(emitter);
      materials.forEach((material) => material.dispose());
      texture.dispose();
      emitter.clear();
    },
  };
}
