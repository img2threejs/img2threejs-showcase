import * as THREE from 'three';

const TRANSFORM_DURATION_SECONDS = 2.2;
const EDGE_FEATHER = 0.085;
const EDGE_BAND = 0.055;

type RevealUniforms = {
  enabled: { value: number };
  frontY: { value: number };
  keepAbove: { value: number };
  feather: { value: number };
  band: { value: number };
  glow: { value: THREE.Color };
};

type RevealMaterial = THREE.MeshStandardMaterial & {
  userData: {
    moltReveal?: RevealUniforms;
    [key: string]: unknown;
  };
};


export interface SoraOutfitVfx {
  readonly group: THREE.Group;
  readonly active: boolean;
  start(outgoing: THREE.SkinnedMesh, incoming: THREE.SkinnedMesh, onComplete: () => void): boolean;
  update(deltaSeconds: number): void;
  dispose(): void;
}

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1);
}

/** Starts slowly at the head, then accelerates decisively toward the feet. */
function acceleratingProgress(progress: number): number {
  return Math.pow(clamp01(progress), 2.65);
}

function materialOf(mesh: THREE.SkinnedMesh): RevealMaterial {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!(material instanceof THREE.MeshStandardMaterial)) {
    throw new Error('Sora outfit VFX requires a MeshStandardMaterial skin');
  }
  return material as RevealMaterial;
}

function installRevealShader(material: RevealMaterial, keepAbove: boolean): RevealUniforms {
  const existing = material.userData.moltReveal;
  if (existing) {
    existing.keepAbove.value = keepAbove ? 1 : 0;
    return existing;
  }

  const uniforms: RevealUniforms = {
    enabled: { value: 0 },
    frontY: { value: Number.POSITIVE_INFINITY },
    keepAbove: { value: keepAbove ? 1 : 0 },
    feather: { value: EDGE_FEATHER },
    band: { value: EDGE_BAND },
    glow: { value: new THREE.Color(0x9adcff) },
  };
  material.userData.moltReveal = uniforms;

  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uMoltEnabled = uniforms.enabled;
    shader.uniforms.uMoltFrontY = uniforms.frontY;
    shader.uniforms.uMoltKeepAbove = uniforms.keepAbove;
    shader.uniforms.uMoltFeather = uniforms.feather;
    shader.uniforms.uMoltBand = uniforms.band;
    shader.uniforms.uMoltGlow = uniforms.glow;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMoltWorldPosition;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvMoltWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vMoltWorldPosition;
         uniform float uMoltEnabled;
         uniform float uMoltFrontY;
         uniform float uMoltKeepAbove;
         uniform float uMoltFeather;
         uniform float uMoltBand;
         uniform vec3 uMoltGlow;
         float soraMoltNoise(vec3 p) {
           return fract(sin(dot(floor(p * 22.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (uMoltEnabled > 0.5) {
           float noisyFront = uMoltFrontY + (soraMoltNoise(vMoltWorldPosition) - 0.5) * uMoltFeather;
           float signedDistance = vMoltWorldPosition.y - noisyFront;
           bool discardFragment = uMoltKeepAbove > 0.5
             ? signedDistance < 0.0
             : signedDistance > 0.0;
           if (discardFragment) discard;
           float edge = 1.0 - smoothstep(0.0, uMoltBand, abs(signedDistance));
           diffuseColor.rgb += uMoltGlow * edge * 2.4;
         }`,
      );
  };
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = (): string => `${previousCacheKey()}|sora-head-to-toe-molt-v2`;
  material.needsUpdate = true;
  return uniforms;
}

/** Surface-only reveal: no surrounding rings, particles or lights. */
export function createSoraOutfitVfx(): SoraOutfitVfx {
  const group = new THREE.Group();
  group.name = 'sora-outfit-vfx';
  let elapsed = 0;
  let headY = 0;
  let feetY = 0;
  let completion: (() => void) | null = null;
  let uniforms: RevealUniforms[] = [];
  let shadows: Array<{ mesh: THREE.SkinnedMesh; castShadow: boolean }> = [];

  const finish = (): void => {
    for (const reveal of uniforms) reveal.enabled.value = 0;
    for (const state of shadows) state.mesh.castShadow = state.castShadow;
    uniforms = [];
    shadows = [];
    const done = completion;
    completion = null;
    done?.();
  };

  return {
    group,
    get active(): boolean { return completion !== null; },
    start(outgoing, incoming, onComplete): boolean {
      if (completion) return false;
      outgoing.updateWorldMatrix(true, true);
      incoming.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(outgoing, true);
      bounds.union(new THREE.Box3().setFromObject(incoming, true));
      const margin = Math.max(EDGE_FEATHER, (bounds.max.y - bounds.min.y) * 0.04);
      headY = bounds.max.y + margin;
      feetY = bounds.min.y - margin;
      uniforms = [
        installRevealShader(materialOf(outgoing), false),
        installRevealShader(materialOf(incoming), true),
      ];
      for (const reveal of uniforms) {
        reveal.frontY.value = headY;
        reveal.enabled.value = 1;
      }
      shadows = [outgoing, incoming].map((mesh) => ({ mesh, castShadow: mesh.castShadow }));
      outgoing.castShadow = false;
      incoming.castShadow = false;
      elapsed = 0;
      completion = onComplete;
      return true;
    },
    update(deltaSeconds): void {
      if (!completion) return;
      elapsed = Math.min(TRANSFORM_DURATION_SECONDS, elapsed + Math.max(0, deltaSeconds));
      const progress = acceleratingProgress(elapsed / TRANSFORM_DURATION_SECONDS);
      const front = THREE.MathUtils.lerp(headY, feetY, progress);
      for (const reveal of uniforms) reveal.frontY.value = front;
      if (elapsed >= TRANSFORM_DURATION_SECONDS) finish();
    },
    dispose: finish,
  };
}
