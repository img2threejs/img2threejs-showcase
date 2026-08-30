import * as THREE from 'three';

/**
 * The pool of light Roblin stands in.
 *
 * HAND-WRITTEN. It is not a shadow and not a light — it is an additive radial gradient laid on the
 * floor and driven by the same colour the aura uses, so the figure is anchored to the ground
 * instead of floating over it. A real light cannot do this cheaply: a point light low enough to
 * pool at the feet also blows out the shins.
 */
export class GroundGlow {
  readonly mesh: THREE.Mesh;

  constructor(radius: number, colour: THREE.Color) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: colour.clone() },
        uIntensity: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColour;
        uniform float uIntensity;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - vec2(0.5)) * 2.0;
          if (d > 1.0) discard;
          float core = pow(1.0 - d, 3.0);
          // A slow breath, plus a faint ripple that keeps the pool from looking like a decal.
          float breath = 0.82 + 0.18 * sin(uTime * 1.6);
          float ripple = 0.06 * sin(d * 22.0 - uTime * 2.4) * (1.0 - d);
          float alpha = (core + ripple) * breath * uIntensity;
          if (alpha <= 0.002) discard;
          gl_FragColor = vec4(uColour * alpha, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), material);
    this.mesh.rotation.x = -Math.PI / 2;
    // Additive and depth-write-free already, but it still has to be drawn UNDER the figure rather
    // than sorted against it, or a foot standing in the pool flickers against it.
    this.mesh.renderOrder = -1;
    this.mesh.name = 'roblin-ground-glow';
  }

  setIntensity(value: number): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uIntensity.value = value;
  }

  setColour(colour: THREE.Color): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uColour.value.copy(colour);
  }

  update(elapsed: number): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
