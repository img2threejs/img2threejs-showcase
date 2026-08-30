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
 * it.
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

  update(dt: number, elapsed: number, left: THREE.Vector3 | undefined, right: THREE.Vector3 | undefined, cameraQuaternion: THREE.Quaternion): void {
    this.level += (this.target - this.level) * Math.min(1, dt * 7);
    const shown = this.level;
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

/**
 * Cheek blush.
 *
 * Two soft discs on the cheeks, parented to the `Head` joint so they ride the head through every
 * clip. Not billboarded, unlike the eye glow: a blush lies ON the cheek, and a disc that turns to
 * face the camera detaches from the face the moment the head turns.
 *
 * Placement is derived from the two measured eye sockets rather than typed in — outward along the
 * line between them and down by a fraction of their separation — so it follows the face this rig
 * actually has instead of a guess at where cheeks usually are.
 *
 * This is the one effect here with no job other than charm.
 */
export class Blush {
  readonly group = new THREE.Group();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private level = 0;
  private target = 1;

  constructor(head: THREE.Object3D, eyeL: [number, number, number], eyeR: [number, number, number], colour: THREE.Color) {
    const mid: [number, number, number] = [(eyeL[0] + eyeR[0]) / 2, (eyeL[1] + eyeR[1]) / 2, (eyeL[2] + eyeR[2]) / 2];
    const span = Math.hypot(eyeL[0] - eyeR[0], eyeL[1] - eyeR[1], eyeL[2] - eyeR[2]);
    const radius = span * 0.40;

    for (const eye of [eyeL, eyeR]) {
      /**
       * Placed ON the head's surface, not offset in free space.
       *
       * The eye sockets were measured on the skin, so their distance from the Head joint IS the
       * surface radius there. Sliding down and outward from an eye without also pushing back out
       * along that radius buries the disc inside the head, where the depth test hides it
       * completely — which is exactly what the first version did.
       *
       * Head-local axes, read off the two measured eye offsets: x is lateral (the eyes differ
       * almost entirely in x), y is up, z is depth.
       */
      const eyeVec = new THREE.Vector3(eye[0], eye[1], eye[2]);
      const surfaceRadius = eyeVec.length();
      const outwardX = eye[0] - mid[0];

      // Down, a little outward, and forward. The eyes on this face are already wide-set, so a
      // large outward push walks the blush round onto the silhouette edge where it reads as a
      // stray light rather than as a cheek — the forward term is what keeps it on the front of
      // the face.
      const direction = eyeVec.clone()
        .add(new THREE.Vector3(outwardX * 0.18, -span * 0.50, -span * 0.28))
        .normalize();
      // A whisker proud of the surface, so it is never z-fought by the skin it sits on.
      const position = direction.multiplyScalar(surfaceRadius * 1.015);

      const material = new THREE.ShaderMaterial({
        uniforms: { uColour: { value: colour.clone() }, uOpacity: { value: 0 } },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform vec3 uColour;
          uniform float uOpacity;
          varying vec2 vUv;
          void main() {
            // Soft radial falloff, raised to a high power so the edge is genuinely gone rather
            // than merely faint — a blush with a visible rim reads as a sticker.
            float r = length(vUv - 0.5) * 2.0;
            float a = max(0.0, 1.0 - r);
            a *= a; a *= a;
            gl_FragColor = vec4(uColour, a * uOpacity);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const disc = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.2, radius * 1.7), material);
      disc.position.copy(position);
      // Face directly away from the head's centre, so the disc lies flat across the cheek.
      disc.lookAt(position.clone().multiplyScalar(2));
      disc.renderOrder = 11;
      this.group.add(disc);
      this.materials.push(material);
    }
    head.add(this.group);
  }

  setLevel(value: number): void { this.target = value; }

  update(dt: number, elapsed: number): void {
    this.level += (this.target - this.level) * Math.min(1, dt * 4);
    // Breathes very slightly, so it is never a completely static patch of colour.
    const breathe = 0.9 + 0.1 * Math.sin(elapsed * 1.7);
    for (const m of this.materials) m.uniforms.uOpacity.value = 0.85 * this.level * breathe;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.group.parent?.remove(this.group);
  }
}
