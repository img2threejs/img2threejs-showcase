import * as THREE from 'three';

/**
 * An expanding ground ring — the readable half of an impact.
 *
 * HAND-WRITTEN. A ring that only scales up reads as a sticker being zoomed; this one thins its
 * band and drops its alpha as it grows, which is what real dust displacement looks like from
 * above. Pooled, because a nova fires several at once.
 */
export class Shockwave {
  readonly mesh: THREE.Mesh;
  private t = 0;
  private duration = 0.6;
  private maxRadius = 1;
  private active = false;

  constructor() {
    // A unit-radius ring in the xy plane, laid flat; radius is driven by the shader, not by scale,
    // so the band keeps a constant screen thickness as the ring grows.
    const geometry = new THREE.RingGeometry(0.0, 1.0, 96, 1);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(0xffffff) },
        uProgress: { value: 0 },
        uThickness: { value: 0.16 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vRadius;
        void main() {
          vUv = uv;
          vRadius = length(position.xy);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColour;
        uniform float uProgress;
        uniform float uThickness;
        varying float vRadius;
        void main() {
          // The band sits at the wavefront and narrows as the wave loses energy.
          float band = uThickness * (1.0 - uProgress * 0.65);
          float d = abs(vRadius - uProgress);
          float ring = smoothstep(band, 0.0, d);
          float fade = pow(1.0 - uProgress, 1.4);
          float alpha = ring * fade;
          if (alpha <= 0.002) discard;
          gl_FragColor = vec4(uColour * alpha * 2.2, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  get busy(): boolean { return this.active; }

  fire(at: THREE.Vector3, radius: number, colour: THREE.Color, duration = 0.6, thickness = 0.16): void {
    this.mesh.position.copy(at);
    this.mesh.scale.setScalar(radius);
    this.maxRadius = radius;
    this.duration = duration;
    const material = this.mesh.material as THREE.ShaderMaterial;
    material.uniforms.uColour.value.copy(colour);
    material.uniforms.uThickness.value = thickness;
    material.uniforms.uProgress.value = 0;
    this.t = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  update(delta: number): void {
    if (!this.active) return;
    this.t += delta;
    const progress = this.t / this.duration;
    if (progress >= 1) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    // Ease out: the wave is fastest the instant it is born.
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uProgress.value = 1 - (1 - progress) ** 2;
  }

  get radius(): number { return this.maxRadius; }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
