import * as THREE from 'three';

const prepared = new WeakSet();
const lightmapSample = 'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );';
const diffuseIbl = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const mapsInclude = '#include <lights_fragment_maps>';
const parsInclude = '#include <lightmap_pars_fragment>';
const rgbmSampling = `
#ifdef USE_LIGHTMAP
uniform float interiorLightmapRange;
vec3 interiorLightmapTexel(ivec2 p) {
  ivec2 size = textureSize(lightMap, 0);
  vec4 encoded = texelFetch(lightMap, clamp(p, ivec2(0), size - 1), 0);
  return encoded.rgb * encoded.a * encoded.a * interiorLightmapRange;
}
vec3 interiorLightmapBilinear(vec2 uv) {
  vec2 p = uv * vec2(textureSize(lightMap, 0)) - 0.5;
  ivec2 base = ivec2(floor(p));
  vec2 f = fract(p);
  return mix(mix(interiorLightmapTexel(base), interiorLightmapTexel(base + ivec2(1, 0)), f.x),
             mix(interiorLightmapTexel(base + ivec2(0, 1)), interiorLightmapTexel(base + ivec2(1, 1)), f.x), f.y);
}
#endif
`;

function requireOnce(source, token) {
  const index = typeof source === 'string' ? source.indexOf(token) : -1;
  if (index < 0 || source.indexOf(token, index + token.length) !== -1) {
    throw new Error(`Three.js shader-contract error: expected one ${token}. Keep the pinned Three r180 build.`);
  }
}

export function prepareRgbmLightmap(texture) {
  if (prepared.has(texture)) return texture;
  if (!texture?.isTexture || !Number.isInteger(texture.image?.width) || texture.image.width <= 0
      || !Number.isInteger(texture.image?.height) || texture.image.height <= 0) {
    throw new Error('RGBM lightmap requires a decoded image with positive integer dimensions.');
  }
  texture.channel = 1;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.generateMipmaps = false;
  // Decode four encoded texels before interpolation; hardware RGBM filtering is incorrect.
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  prepared.add(texture);
  return texture;
}

export function bindBakedLightmap(material, atlas) {
  if (!material?.isMeshStandardMaterial || !Number.isFinite(atlas?.range) || atlas.range <= 0
      || !Number.isFinite(atlas.intensity) || atlas.intensity <= 0) {
    throw new Error('Baked PBR material requires its declared RGBM range and irradiance intensity.');
  }
  const maps = THREE.ShaderChunk.lights_fragment_maps;
  requireOnce(maps, lightmapSample);
  requireOnce(maps, diffuseIbl);
  const bakedMaps = maps.replace(lightmapSample,
    'vec4 lightMapTexel = vec4( interiorLightmapBilinear( vLightMapUv ), 1.0 );')
    .replace(diffuseIbl, '// Diffuse irradiance comes from the native ambient bake only.');
  const previousCompile = material.onBeforeCompile;
  const programKey = `${material.customProgramCacheKey()}|interior-rgbm-webp-m2-r180`;
  material.lightMap = prepareRgbmLightmap(atlas.texture);
  material.lightMapIntensity = atlas.intensity;
  material.onBeforeCompile = function(shader, renderer) {
    previousCompile.call(this, shader, renderer);
    requireOnce(shader.fragmentShader, mapsInclude);
    requireOnce(shader.fragmentShader, parsInclude);
    shader.uniforms.interiorLightmapRange = { value: atlas.range };
    shader.fragmentShader = shader.fragmentShader.replace(parsInclude, parsInclude + rgbmSampling)
      .replace(mapsInclude, bakedMaps);
  };
  material.customProgramCacheKey = () => programKey;
  material.needsUpdate = true;
  return material;
}
