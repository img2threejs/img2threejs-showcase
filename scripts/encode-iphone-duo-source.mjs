#!/usr/bin/env node

/**
 * Offline source encoder for the iPhone Duo.
 *
 * This optional offline utility is not part of the build. It imports
 * GLTFLoader for the Apple source. The generated module contains a Three.js
 * ObjectLoader scene description plus the original embedded image bytes; the
 * browser never fetches or parses the source GLB.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const args = process.argv.slice(2);
const help = `Optional iPhone Duo reference encoder (not needed to build or run).
Usage: node scripts/encode-iphone-duo-source.mjs [hyper3d] /absolute/path/to/reference.glb
Start the iPhone Duo dev server first. Set IPHONE_DUO_ENCODER_URL if needed.
Playwright must be installed separately or supplied via IPHONE_DUO_PLAYWRIGHT_MODULE.
The reference file is read in place; it is not copied into the repository.`;
if (args.includes('--help') || args.includes('-h')) {
  console.log(help);
  process.exit(0);
}
const provider = args[0] === 'hyper3d';
if (provider) args.shift();
if (args.length !== 1) {
  console.error(help);
  process.exit(1);
}
const sourcePath = resolve(args[0]);
if (!existsSync(sourcePath)) throw new Error(`Reference file not found: ${sourcePath}`);
const playwrightModule = process.env.IPHONE_DUO_PLAYWRIGHT_MODULE ?? 'playwright';
let chromium;
try {
  ({ chromium } = await import(playwrightModule));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Unable to import Playwright from ${playwrightModule}. `
      + 'Install Playwright or set IPHONE_DUO_PLAYWRIGHT_MODULE to its module path. '
      + `Original error: ${reason}`,
  );
}
const outputPath = resolve(repositoryRoot, provider
  ? 'src/iphone-duo/encodedHyper3d.ts'
  : 'src/iphone-duo/encodedSource.ts');
const serverUrl = process.env.IPHONE_DUO_ENCODER_URL ?? 'http://127.0.0.1:5274/iphone-duo.html#encode';
const exportName = provider ? 'IPHONE_DUO_HYPER3D_ENCODED_SOURCE' : 'IPHONE_DUO_ENCODED_SOURCE';
const sourceUrlLabel = provider ? 'hyper3d-source' : 'apple-source';

function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function parseGlb(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 20 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'glTF') {
    throw new Error('The source is not a valid GLB');
  }
  const view = new DataView(buffer);
  let offset = 12;
  let json;
  let binary;
  while (offset < bytes.length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 'JSON') json = JSON.parse(new TextDecoder().decode(chunk).trim());
    if (chunkType === 'BIN\u0000') binary = chunk;
    offset += 8 + chunkLength;
  }
  if (!json || !binary) throw new Error('The source GLB has no JSON or BIN chunk');
  return { json, binary };
}

async function main() {
  const sourceBuffer = await fs.readFile(sourcePath);
  const { json: gltfJson, binary } = parseGlb(sourceBuffer.buffer.slice(sourceBuffer.byteOffset, sourceBuffer.byteOffset + sourceBuffer.byteLength));
  const sourceImageData = {};
  for (const image of gltfJson.images ?? []) {
    if (image.bufferView === undefined) throw new Error(`Image ${image.name ?? '(unnamed)'} is not embedded`);
    const bufferView = gltfJson.bufferViews[image.bufferView];
    const imageBytes = binary.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength);
    sourceImageData[image.name] = {
      mimeType: image.mimeType,
      data: toBase64(imageBytes),
    };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    const sourceBytes = await fs.readFile(sourcePath);
    const sourceBuffer = sourceBytes.buffer.slice(
      sourceBytes.byteOffset,
      sourceBytes.byteOffset + sourceBytes.byteLength,
    );
    const sourceBase64 = toBase64(new Uint8Array(sourceBuffer));
    const encoded = await page.evaluate(async ({ rawImages, sourceBase64, sourceUrlLabel }) => {
      const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
      const binary = atob(sourceBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
      const exactMaterials = {};
      const exactTextures = {};
      const exactTransforms = {};
      const textureSourceNames = {};
      const colourKeys = ['color', 'emissive', 'sheenColor', 'specularColor', 'attenuationColor', 'blendColor'];
      const scalarKeys = [
        'opacity', 'transparent', 'alphaTest', 'side', 'shadowSide', 'vertexColors',
        'depthTest', 'depthWrite', 'colorWrite', 'stencilWrite', 'stencilFunc',
        'stencilRef', 'stencilFuncMask', 'stencilFail', 'stencilZFail', 'stencilZPass',
        'blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha',
        'blendEquationAlpha', 'premultipliedAlpha', 'dithering', 'flatShading', 'fog',
        'toneMapped', 'wireframe', 'wireframeLinewidth', 'wireframeLinecap', 'wireframeLinejoin',
        'metalness', 'roughness', 'clearcoat', 'clearcoatRoughness', 'ior', 'transmission',
        'thickness', 'attenuationDistance', 'sheen', 'sheenRoughness', 'iridescence',
        'iridescenceIOR', 'anisotropy', 'anisotropyRotation', 'specularIntensity',
        'visible',
      ];
      const sourceMaterials = new Map();
      const sourceTextures = new Map();
      gltf.scene.traverse((object) => {
        exactTransforms[object.uuid] = {
          position: object.position.toArray(),
          quaternion: object.quaternion.toArray(),
          scale: object.scale.toArray(),
          matrix: object.matrix.toArray(),
          matrixAutoUpdate: object.matrixAutoUpdate,
          matrixWorldAutoUpdate: object.matrixWorldAutoUpdate,
          visible: object.visible,
          castShadow: object.castShadow,
          receiveShadow: object.receiveShadow,
          frustumCulled: object.frustumCulled,
          renderOrder: object.renderOrder,
        };
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!sourceMaterials.has(material.uuid)) sourceMaterials.set(material.uuid, material);
          for (const value of Object.values(material)) {
            if (!value?.isTexture) continue;
            if (!sourceTextures.has(value.uuid)) sourceTextures.set(value.uuid, value);
          }
        }
      });
      for (const [uuid, material] of sourceMaterials) {
        const exact = {};
        for (const key of colourKeys) {
          const value = material[key];
          if (value?.isColor) exact[key] = value.toArray();
        }
        const scalars = {};
        for (const key of scalarKeys) {
          const value = material[key];
          if (typeof value === 'number' && Number.isFinite(value)) scalars[key] = value;
          else if (typeof value === 'boolean') scalars[key] = value;
          else if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) scalars[key] = [...value];
        }
        exact.scalars = scalars;
        exactMaterials[uuid] = exact;
      }
      for (const [uuid, texture] of sourceTextures) {
        const association = gltf.parser.associations.get(texture);
        const sourceIndex = association?.textures === undefined
          ? gltf.parser.json.images.findIndex((candidate) => candidate.name === texture.name)
          : gltf.parser.json.textures[association.textures]?.source;
        const sourceImage = sourceIndex === undefined || sourceIndex < 0
          ? undefined
          : gltf.parser.json.images[sourceIndex];
        if (!sourceImage?.name || !rawImages[sourceImage.name]) {
          throw new Error(`Texture ${texture.name || uuid} has no matching embedded source image`);
        }
        textureSourceNames[uuid] = sourceImage.name;
        exactTextures[uuid] = {
          matrixAutoUpdate: texture.matrixAutoUpdate,
          matrix: texture.matrix.toArray(),
          colorSpace: texture.colorSpace,
          flipY: texture.flipY,
          premultiplyAlpha: texture.premultiplyAlpha,
          unpackAlignment: texture.unpackAlignment,
          sourceUuid: texture.source.uuid,
          sourceName: texture.name,
        };
      }

      const scene = gltf.scene.toJSON();
      // Object3D.toJSON() records materials in first-use traversal order, but
      // WebGLRenderLists uses material.id to break opaque ties. Preserve the
      // GLTFLoader creation order so coincident source surfaces keep the same
      // draw order after ObjectLoader parses the embedded scene.
      const sourceMaterialIds = new Map(
        [...sourceMaterials.entries()].map(([uuid, material]) => [uuid, material.id]),
      );
      if (Array.isArray(scene.materials)) {
        scene.materials.sort((left, right) => (
          (sourceMaterialIds.get(left.uuid) ?? Number.MAX_SAFE_INTEGER)
          - (sourceMaterialIds.get(right.uuid) ?? Number.MAX_SAFE_INTEGER)
        ));
      }
      const rawByName = rawImages;
      for (const image of scene.images ?? []) {
        const texture = (scene.textures ?? []).find((candidate) => candidate.image === image.uuid);
        const raw = texture ? rawByName[textureSourceNames[texture.uuid]] : undefined;
        if (!raw) throw new Error(`Scene image ${image.uuid} was not mapped to original embedded bytes`);
        image.url = `data:${raw.mimeType};base64,${raw.data}`;
      }

      // Keep geometry attribute bytes lossless and compact. ObjectLoader's
      // BufferGeometryLoader accepts typed arrays; the runtime expands these
      // byte strings before handing the scene to it.
      const encodeArray = (descriptor) => {
        if (!descriptor?.type || !Array.isArray(descriptor.array)) return descriptor;
        const Constructor = globalThis[descriptor.type];
        if (typeof Constructor !== 'function') throw new Error(`Unsupported attribute type ${descriptor.type}`);
        const typed = new Constructor(descriptor.array);
        const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
        }
        return { ...descriptor, array: btoa(binary), arrayEncoding: 'base64' };
      };
      for (const geometry of scene.geometries ?? []) {
        const data = geometry.data;
        for (const [key, descriptor] of Object.entries(data.attributes ?? {})) data.attributes[key] = encodeArray(descriptor);
        if (data.index) data.index = encodeArray(data.index);
        for (const morph of Object.values(data.morphAttributes ?? {})) {
          for (let index = 0; index < morph.length; index += 1) morph[index] = encodeArray(morph[index]);
        }
      }

      return {
        scene,
        exactTransforms,
        exactMaterials,
        exactTextures,
        source: {
          file: sourceUrlLabel,
          generator: gltf.parser.json.asset?.generator ?? null,
          sceneName: gltf.scene.name,
          nodeCount: Object.keys(exactTransforms).length,
          geometryCount: scene.geometries?.length ?? 0,
          materialCount: scene.materials?.length ?? 0,
          textureCount: scene.textures?.length ?? 0,
          imageCount: scene.images?.length ?? 0,
        },
      };
    }, { rawImages: sourceImageData, sourceBase64, sourceUrlLabel });

    const sourceJson = JSON.stringify(encoded);
    const moduleSource = `/**\n * GENERATED by scripts/encode-iphone-duo-source.mjs${provider ? ' hyper3d' : ''}.\n *\n * This module is the lossless measured-surface payload for the ${provider ? 'provider' : 'Apple'} source.\n * It is consumed by ObjectLoader at runtime; no external model asset is fetched there.\n */\n\nexport const ${exportName} = JSON.parse(${JSON.stringify(sourceJson)});\n`;
    await fs.writeFile(outputPath, moduleSource);
    console.log(JSON.stringify({
      outputPath,
      bytes: Buffer.byteLength(moduleSource),
      source: encoded.source,
      sourceImagesBytes: Object.values(sourceImageData).reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

await main();
