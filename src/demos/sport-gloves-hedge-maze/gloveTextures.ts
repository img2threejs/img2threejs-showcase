import * as THREE from 'three';

export type GloveSurfaceMaterials = {
  readonly dorsal: THREE.MeshPhysicalMaterial;
  readonly palmar: THREE.MeshPhysicalMaterial;
  readonly fingerDorsal: THREE.MeshPhysicalMaterial;
  readonly fingerPalmar: THREE.MeshPhysicalMaterial;
  readonly thumbDorsal: THREE.MeshPhysicalMaterial;
  readonly thumbPalmar: THREE.MeshPhysicalMaterial;
  readonly side: THREE.MeshPhysicalMaterial;
  readonly tipDorsal: THREE.MeshPhysicalMaterial;
  readonly tipPalmar: THREE.MeshPhysicalMaterial;
  readonly tipCrown: THREE.MeshPhysicalMaterial;
};

const SURFACE = {
  dorsal: 'references/hedge-maze-dorsal.png',
  palmar: 'references/hedge-maze-palmar.png',
  normalStrength: 1.7,
} as const;

function createTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  mirrored: boolean,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  if (mirrored) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    texture.offset.x = 1;
  }
  texture.needsUpdate = true;
  return texture;
}

function derivePbrChannels(
  source: ImageData,
): { readonly normal: HTMLCanvasElement; readonly roughness: HTMLCanvasElement } {
  const { width, height, data } = source;
  const normalCanvas = document.createElement('canvas');
  const roughnessCanvas = document.createElement('canvas');
  normalCanvas.width = width;
  normalCanvas.height = height;
  roughnessCanvas.width = width;
  roughnessCanvas.height = height;
  const normalContext = normalCanvas.getContext('2d');
  const roughnessContext = roughnessCanvas.getContext('2d');
  if (!normalContext || !roughnessContext) {
    throw new Error('Projected glove PBR canvas context unavailable');
  }

  const normalPixels = normalContext.createImageData(width, height);
  const roughnessPixels = roughnessContext.createImageData(width, height);
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luminance[index] = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
  }

  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1);
    const down = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      const index = y * width + x;
      const offset = index * 4;
      const alpha = data[offset + 3];
      const dx = (luminance[y * width + right] - luminance[y * width + left]) / 255;
      const dy = (luminance[down * width + x] - luminance[up * width + x]) / 255;
      const nx = -dx * SURFACE.normalStrength;
      const ny = dy * SURFACE.normalStrength;
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      normalPixels.data[offset] = Math.round((nx * inverseLength * 0.5 + 0.5) * 255);
      normalPixels.data[offset + 1] = Math.round((ny * inverseLength * 0.5 + 0.5) * 255);
      normalPixels.data[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      normalPixels.data[offset + 3] = 255;

      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const isCharcoalArmor = alpha > 8 && red < 90 && green < 100 && blue < 105;
      const isLimeRubber = alpha > 8 && green > red * 1.18 && green > blue * 1.25;
      const weave = ((x * 17 + y * 31) % 13) - 6;
      const roughness = isCharcoalArmor ? 205 + weave : isLimeRubber ? 220 + weave : 238 + weave;
      roughnessPixels.data[offset] = roughness;
      roughnessPixels.data[offset + 1] = roughness;
      roughnessPixels.data[offset + 2] = roughness;
      roughnessPixels.data[offset + 3] = 255;
    }
  }
  normalContext.putImageData(normalPixels, 0, 0);
  roughnessContext.putImageData(roughnessPixels, 0, 0);
  return { normal: normalCanvas, roughness: roughnessCanvas };
}

function removeConnectedBlackBackground(source: ImageData, threshold = 18): ImageData {
  const { width, height } = source;
  const pixels = new Uint8ClampedArray(source.data);
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueue = (x: number, y: number): void => {
    const index = y * width + x;
    if (visited[index] === 1) return;
    const offset = index * 4;
    const brightestChannel = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    if (brightestChannel > threshold) return;
    visited[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart];
    queueStart += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    const offset = index * 4;
    pixels[offset + 3] = 0;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }

  return new ImageData(pixels, width, height);
}

function padTransparentEdge(
  source: ImageData,
  fallbackColor?: readonly [number, number, number],
  passes = 14,
): ImageData {
  const { width, height } = source;
  let pixels = new Uint8ClampedArray(source.data);
  const offsets = [-1, 0, 1] as const;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8ClampedArray(pixels);
    let changed = false;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelOffset = (y * width + x) * 4;
        if (pixels[pixelOffset + 3] > 8) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let contributors = 0;
        for (const offsetY of offsets) {
          const sampleY = y + offsetY;
          if (sampleY < 0 || sampleY >= height) continue;
          for (const offsetX of offsets) {
            const sampleX = x + offsetX;
            if ((offsetX === 0 && offsetY === 0) || sampleX < 0 || sampleX >= width) continue;
            const sampleOffset = (sampleY * width + sampleX) * 4;
            if (pixels[sampleOffset + 3] <= 8) continue;
            red += pixels[sampleOffset];
            green += pixels[sampleOffset + 1];
            blue += pixels[sampleOffset + 2];
            contributors += 1;
          }
        }
        if (contributors === 0) continue;
        next[pixelOffset] = Math.round(red / contributors);
        next[pixelOffset + 1] = Math.round(green / contributors);
        next[pixelOffset + 2] = Math.round(blue / contributors);
        next[pixelOffset + 3] = 255;
        changed = true;
      }
    }
    pixels = next;
    if (!changed) break;
  }

  if (fallbackColor) {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] > 8) continue;
      pixels[offset] = fallbackColor[0];
      pixels[offset + 1] = fallbackColor[1];
      pixels[offset + 2] = fallbackColor[2];
      pixels[offset + 3] = 255;
    }
  }
  return new ImageData(pixels, width, height);
}

function createFabricMaterial(
  name: string,
  baseColor: string,
  stripeColor: string,
  stripeOpacity = 0.18,
): THREE.MeshPhysicalMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Procedural glove fabric canvas context unavailable');
  context.fillStyle = baseColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = stripeOpacity;
  context.strokeStyle = stripeColor;
  context.lineWidth = 1;
  for (let y = 1; y < canvas.height; y += 4) {
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(canvas.width, y + 0.5);
    context.stroke();
  }
  context.globalAlpha = stripeOpacity * 0.3;
  for (let x = 2; x < canvas.width; x += 6) {
    context.beginPath();
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, canvas.height);
    context.stroke();
  }
  context.globalAlpha = 1;

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(8, 12);
  map.channel = 1;
  map.anisotropy = 8;
  map.needsUpdate = true;

  const material = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.94,
    metalness: 0,
    sheen: 0.04,
    sheenColor: new THREE.Color(baseColor),
    sheenRoughness: 0.98,
    clearcoat: 0,
    specularIntensity: 0.08,
  });
  material.name = name;
  return material;
}

function createTipCrownMaterial(): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#4b8534'),
    roughness: 0.96,
    metalness: 0,
    sheen: 0.03,
    sheenColor: new THREE.Color('#6ea158'),
    sheenRoughness: 0.98,
    clearcoat: 0,
    specularIntensity: 0.06,
  });
  material.name = 'green-tip-crown-fabric';
  return material;
}

function createProjectedMaterial(
  imageUrl: string,
  mirrored: boolean,
  name: string,
  fallbackColor?: readonly [number, number, number],
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    sheen: 0.06,
    sheenColor: new THREE.Color(0x91a99a),
    sheenRoughness: 0.96,
    clearcoat: 0,
    specularIntensity: 0.08,
    ior: 1.45,
    alphaTest: 0.05,
    depthWrite: true,
  });
  material.name = name;

  const image = new Image();
  image.decoding = 'async';
  image.onload = (): void => {
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = image.naturalWidth;
    albedoCanvas.height = image.naturalHeight;
    const context = albedoCanvas.getContext('2d');
    if (!context) throw new Error('Projected glove albedo canvas context unavailable');
    context.drawImage(image, 0, 0);
    const foreground = removeConnectedBlackBackground(
      context.getImageData(0, 0, albedoCanvas.width, albedoCanvas.height),
    );
    const source = padTransparentEdge(
      foreground,
      fallbackColor,
    );
    context.putImageData(source, 0, 0);
    const pbr = derivePbrChannels(source);
    material.map = createTexture(albedoCanvas, THREE.SRGBColorSpace, mirrored);
    material.normalMap = createTexture(pbr.normal, THREE.LinearSRGBColorSpace, mirrored);
    material.roughnessMap = createTexture(pbr.roughness, THREE.LinearSRGBColorSpace, mirrored);
    material.normalScale = new THREE.Vector2(mirrored ? -0.58 : 0.58, 0.58);
    material.needsUpdate = true;
  };
  image.src = `${import.meta.env.BASE_URL}${imageUrl}`;
  return material;
}

export function createGloveSurfaceMaterials(): GloveSurfaceMaterials {
  const dorsal = createProjectedMaterial(SURFACE.dorsal, false, 'hedge-maze-dorsal-projection');
  const palmar = createProjectedMaterial(SURFACE.palmar, true, 'hedge-maze-palmar-projection');
  const tipDorsal = createFabricMaterial('lime-dorsal-tip-fabric', '#589d3d', '#94cd75', 0.14);
  const tipPalmar = createFabricMaterial('olive-palmar-tip-fabric', '#59673e', '#829161', 0.12);
  const side = createFabricMaterial('fourchette-edge-fabric', '#8a9598', '#c0c7c8', 0.08);
  const tipCrown = createTipCrownMaterial();
  return {
    dorsal,
    palmar,
    fingerDorsal: dorsal,
    fingerPalmar: palmar,
    thumbDorsal: dorsal,
    thumbPalmar: palmar,
    side,
    tipDorsal,
    tipPalmar,
    tipCrown,
  };
}
