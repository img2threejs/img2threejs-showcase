import * as THREE from 'three';
import type { SoraSkinId } from './createSoraModel';
import { decodeFloats } from './meshCodec';
import { SURFACE_UV as UV_A } from './surfaceUv.skin-a';
import { SURFACE_UV as UV_B } from './surfaceUv.skin-b';
import albedoA from './textures/skin-a-albedo.jpg';
import normalA from './textures/skin-a-normal.jpg';
import ormA from './textures/skin-a-orm.jpg';
import albedoB from './textures/skin-b-albedo.jpg';
import normalB from './textures/skin-b-normal.jpg';
import ormB from './textures/skin-b-orm.jpg';

// Immutable, shared texture resources survive outfit swaps. Materials/geometries
// remain per-instance; disposing an outgoing outfit must not dispose these maps.
function surface(uv: string, urls: readonly string[]) {
  const maps = urls.map((url, index) => {
    const texture = new THREE.Texture();
    texture.name = url.substring(url.lastIndexOf('/') + 1);
    texture.flipY = false; // Original glTF UV/image convention.
    texture.colorSpace = index === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 4;
    return texture;
  });
  return { uv: decodeFloats(uv), urls, maps };
}
const surfaces = {
  default: surface(UV_A, [albedoA, normalA, ormA]),
  'kingdom-key': surface(UV_B, [albedoB, normalB, ormB]),
};
let ready: Promise<void> | undefined;

/** Local bundled images only; no provider URLs, credentials or runtime GLB. */
export function prewarmSoraSurfaceAppearance(): Promise<void> {
  ready ??= Promise.all(Object.values(surfaces).flatMap(({ urls, maps }) =>
    urls.map(async (url, index) => {
      if (maps[index].image) return;
      const image = await new THREE.ImageLoader().loadAsync(url);
      maps[index].image = image;
      maps[index].needsUpdate = true;
    }),
  )).then(() => undefined).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

export function applySoraSurfaceAppearance(mesh: THREE.SkinnedMesh, skin: SoraSkinId): void {
  const { uv, maps: [albedo, normal, orm] } = surfaces[skin];
  if (uv.length !== mesh.geometry.getAttribute('position').count * 2) {
    throw new Error(`Sora ${skin}: original UVs do not match the embedded surface`);
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const material = mesh.material as THREE.MeshStandardMaterial;
  material.vertexColors = false; // Do not multiply the recovered albedo by blurred vertex colour.
  material.color.set(0xffffff);
  material.map = albedo;
  material.normalMap = normal;
  material.normalScale.set(0.35, 0.35);
  material.roughnessMap = orm;
  material.metalnessMap = orm;
  material.roughness = 1;
  material.metalness = 1;
  // The generated normal/ORM maps overstate relief and gloss: the reference
  // checks are printed fabric, not raised metal, and the face is not polished.
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
       float soraDielectric = 1.0 - smoothstep(0.05, 0.25, metalnessFactor);
       roughnessFactor = max(roughnessFactor, mix(0.12, 0.52, soraDielectric));`,
    );
  };
  material.customProgramCacheKey = (): string => `${previousKey()}|sora-reference-finish`;
  material.needsUpdate = true;
}
