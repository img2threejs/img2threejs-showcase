/**
 * A fresnel rim on the fur, and a glow that can be driven into the eyes.
 *
 * HAND-WRITTEN — see the note in `particles.ts`.
 *
 * This is the single biggest change to how the character reads, and it costs no extra draw call:
 * the surface material is patched through `onBeforeCompile` so the existing MeshStandardMaterial
 * gains a view-dependent rim term on its emissive output. Nothing about the base colour, the
 * measured vertex colours or the PBR scalars is touched.
 *
 * Why a rim and not another light: the subject is a round, matte, almost featureless silhouette in
 * a dark scene, and a fifth light would flatten it further. A fresnel term does the opposite — it
 * brightens exactly where the surface turns away from the viewer, which is the contour. On a shape
 * this round that is what separates it from the background and gives the fur its edge.
 *
 * The colour is `ACCENT.energy`, the same saturated cyan derived from the measured fur that every
 * effect is made of, so the rim belongs to the same palette as the sparks and the trails rather
 * than reading as a separate lighting decision.
 */
import * as THREE from 'three';

export interface RimUniforms {
  /** Rim strength. 0 disables it entirely. */
  uRimStrength: { value: number };
  /** How tight the rim is to the contour. Higher is a thinner edge. */
  uRimPower: { value: number };
  uRimColour: { value: THREE.Color };
  /** Extra rim added on top, for charge-ups. */
  uRimPulse: { value: number };
}

const RIM_PARS = /* glsl */`
  uniform float uRimStrength;
  uniform float uRimPower;
  uniform float uRimPulse;
  uniform vec3 uRimColour;
  varying vec3 vRimViewPosition;
  varying vec3 vRimNormal;
`;

/**
 * Patch a MeshStandardMaterial with a fresnel rim.
 *
 * The rim is added to `totalEmissiveRadiance`, which is the one output that is not multiplied by
 * incoming light — so the contour holds up on the shadow side, which is precisely where a rim is
 * doing its job.
 */
export function installRimLight(
  material: THREE.MeshStandardMaterial,
  colour: THREE.Color,
  strength = 0.55,
  power = 2.6,
): RimUniforms {
  const uniforms: RimUniforms = {
    uRimStrength: { value: strength },
    uRimPower: { value: power },
    uRimColour: { value: colour.clone() },
    uRimPulse: { value: 0 },
  };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vRimViewPosition;\n varying vec3 vRimNormal;`)
      // After project_vertex so `mvPosition` is the skinned, posed position rather than the
      // bind-pose one — on an animated character those are not the same vector.
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vRimViewPosition = - mvPosition.xyz;
         vRimNormal = normalize( normalMatrix * objectNormal );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float rimFacing = 1.0 - clamp( dot( normalize( vRimNormal ), normalize( vRimViewPosition ) ), 0.0, 1.0 );
         float rim = pow( rimFacing, uRimPower ) * ( uRimStrength + uRimPulse );
         totalEmissiveRadiance += uRimColour * rim;`,
      );
  };

  // Without a distinct cache key the renderer can hand this material a program compiled for an
  // unpatched one.
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function rimCacheKey(this: THREE.Material): string {
    return `${previousKey ? previousKey.call(this) : ''}|monster-cute-rim`;
  };
  material.needsUpdate = true;
  return uniforms;
}

/**
 * A pair of glowing discs sitting on the measured eye sockets.
 *
 * Billboarded and additive, so they read as light coming out of the eye rather than as a decal on
 * it. Scaled by the blink, because an eye that keeps glowing through a closed lid is the sort of
 * detail that quietly ruins the effect.
 */
export class EyeGlow {
  readonly group = new THREE.Group();
  private readonly discs: THREE.Mesh[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private level = 0;
  private target = 0;

  constructor(radius: number, colour: THREE.Color) {
    for (let i = 0; i < 2; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: colour.clone(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), material);
      disc.visible = false;
      disc.renderOrder = 12;
      this.group.add(disc);
      this.discs.push(disc);
      this.materials.push(material);
    }
    this.group.visible = false;
  }

  setLevel(value: number): void { this.target = value; }

  update(dt: number, elapsed: number, left: THREE.Vector3 | undefined, right: THREE.Vector3 | undefined, cameraQuaternion: THREE.Quaternion, openness: number): void {
    this.level += (this.target - this.level) * Math.min(1, dt * 7);
    const shown = this.level * openness;
    this.group.visible = shown > 0.01;
    if (!this.group.visible) return;
    const flicker = 0.85 + 0.15 * Math.sin(elapsed * 17.3);
    const places = [left, right];
    for (let i = 0; i < 2; i += 1) {
      const place = places[i];
      const disc = this.discs[i];
      if (!place) { disc.visible = false; continue; }
      disc.visible = true;
      disc.position.copy(place);
      disc.quaternion.copy(cameraQuaternion);
      disc.scale.setScalar(0.7 + 0.5 * shown);
      this.materials[i].opacity = 0.85 * shown * flicker;
    }
  }

  dispose(): void {
    this.discs[0]?.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}
