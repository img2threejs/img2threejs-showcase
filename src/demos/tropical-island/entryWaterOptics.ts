import * as THREE from 'three';

export interface EntryWaterOptics {
  createMaterial(thickness: number): THREE.MeshPhysicalMaterial;
  beforeRender: THREE.Object3D['onBeforeRender'];
  dispose(): void;
}

// Stock transmission omits the transparent sea. Capture it after compositing,
// once before the entry meshes, without rendering the scene a second time.
export function createEntryWaterOptics(seaMaterial: THREE.MeshPhysicalMaterial): EntryWaterOptics {
  const backdrop = { value: null as THREE.FramebufferTexture | null };
  const bufferSize = { value: new THREE.Vector2() };
  const projectionScale = { value: new THREE.Vector2() };
  const srgbOutput = { value: true };
  const viewport = new THREE.Vector4();
  let frame = -1;
  let lastRenderer: THREE.WebGLRenderer | null = null;
  let lastCamera: THREE.Camera | null = null;
  let lastTarget: THREE.WebGLRenderTarget | null = null;
  let disposed = false;

  const beforeRender: THREE.Object3D['onBeforeRender'] = (renderer, _scene, camera, _geometry, material) => {
    if (disposed) return;
    (material as THREE.MeshPhysicalMaterial).envMapIntensity = seaMaterial.envMapIntensity;
    const target = renderer.getRenderTarget();
    if (renderer === lastRenderer && camera === lastCamera && target === lastTarget
      && renderer.info.render.frame === frame) return;

    if (target) bufferSize.value.set(target.width, target.height);
    else renderer.getDrawingBufferSize(bufferSize.value);
    const { x: width, y: height } = bufferSize.value;
    const type = target?.texture.type ?? THREE.UnsignedByteType;
    const format = target?.texture.format ?? THREE.RGBAFormat;
    let texture = backdrop.value;
    if (!texture || texture.image.width !== width || texture.image.height !== height
      || texture.type !== type || texture.format !== format) {
      texture?.dispose();
      texture = new THREE.FramebufferTexture(width, height);
      texture.type = type;
      texture.format = format;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.NoColorSpace;
      backdrop.value = texture;
    }
    renderer.getCurrentViewport(viewport);
    const p = camera.projectionMatrix.elements;
    projectionScale.value.set(p[0]! * viewport.z / width, p[5]! * viewport.w / height);
    srgbOutput.value = (target?.texture.colorSpace ?? renderer.outputColorSpace) === THREE.SRGBColorSpace;
    renderer.copyFramebufferToTexture(texture);
    frame = renderer.info.render.frame;
    lastRenderer = renderer;
    lastCamera = camera;
    lastTarget = target;
  };

  const createMaterial = (thickness: number): THREE.MeshPhysicalMaterial => {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.045,
      metalness: 0,
      ior: 1.333,
      envMap: seaMaterial.envMap,
      envMapIntensity: seaMaterial.envMapIntensity,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    material.name = 'Clear entry water';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.entryBackdrop = backdrop;
      shader.uniforms.entryBufferSize = bufferSize;
      shader.uniforms.entryProjectionScale = projectionScale;
      shader.uniforms.entrySrgbOutput = srgbOutput;
      shader.uniforms.entryThickness = { value: thickness };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float entryThickness;
          varying float vEntryThickness;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vEntryThickness = 2.0 * length(mat3(modelMatrix) * instanceMatrix[0].xyz);
          #else
            vEntryThickness = entryThickness;
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D entryBackdrop;
          uniform vec2 entryBufferSize;
          uniform vec2 entryProjectionScale;
          uniform bool entrySrgbOutput;
          varying float vEntryThickness;
          vec3 entryDisplayToLinear(vec3 color) {
            return mix(pow((color + 0.055) / 1.055, vec3(2.4)), color / 12.92,
              vec3(lessThanEqual(color, vec3(0.04045))));
          }`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
          material.diffuseColor = vec3(0.0);`)
        // Add reflection in display-linear light, not gamma-encoded values.
        // No second tone map or fog pass; alpha remains the geometry's coverage.
        .replace('#include <fog_fragment>', `
          vec3 entryIncident = -geometryViewDir;
          vec3 entryRefracted = refract(entryIncident, normal, 1.0 / 1.333);
          float entryDepth = isOrthographic ? 1.0 : max(vViewPosition.z, 0.1);
          vec2 entryExtent = 0.5 * entryProjectionScale * vEntryThickness / entryDepth;
          vec2 entryBend = entryExtent * (
            entryRefracted.xy / max(-entryRefracted.z, 0.1)
            - entryIncident.xy / max(-entryIncident.z, 0.1));
          entryBend = clamp(entryBend, -entryExtent, entryExtent);
          vec2 entryMargin = 0.5 / entryBufferSize;
          vec2 entryUv = clamp(gl_FragCoord.xy / entryBufferSize + entryBend,
            entryMargin, vec2(1.0) - entryMargin);
          float entryCosine = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
          float entryFresnel = 0.0204 + 0.9796 * pow(1.0 - entryCosine, 5.0);
          vec3 entryBackground = texture2D(entryBackdrop, entryUv).rgb;
          vec3 entryReflection = gl_FragColor.rgb;
          if (entrySrgbOutput) {
            entryBackground = entryDisplayToLinear(entryBackground);
            entryReflection = entryDisplayToLinear(entryReflection);
          }
          vec3 entryComposite = entryBackground * (1.0 - entryFresnel) + entryReflection;
          gl_FragColor.rgb = entrySrgbOutput
            ? sRGBTransferOETF(vec4(entryComposite, 1.0)).rgb : entryComposite;`);
    };
    material.customProgramCacheKey = () => 'entry-water-optics-v4';
    return material;
  };

  return {
    createMaterial,
    beforeRender,
    dispose() {
      if (disposed) return;
      disposed = true;
      backdrop.value?.dispose();
      backdrop.value = null;
      lastRenderer = null;
      lastCamera = null;
      lastTarget = null;
    },
  };
}
