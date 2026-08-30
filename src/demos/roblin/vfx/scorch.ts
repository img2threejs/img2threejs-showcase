import * as THREE from 'three';

/**
 * A scorch mark that outlives the blast.
 *
 * HAND-WRITTEN. Every other impact primitive here is over in under a second, which is correct for
 * light but wrong for fire: a burst that leaves nothing behind reads as a flash rather than as
 * something having burned. This is the slow half — a dark ring with a glowing rim that cools from
 * white through the ember hue to nothing over a second and a half, so the third punch of a
 * combination lands on ground the first two have already marked.
 *
 * It is additive like everything else in this folder, so it can only ever brighten the floor; a
 * true soot mark would need to darken it, which additive blending cannot do. The dark centre here
 * is an absence of glow, not a stain.
 */
export class Scorch {
  readonly mesh: THREE.Mesh;
  private t = 0;
  private duration = 1.4;
  private active = false;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uHot: { value: new THREE.Color(0xffffff) },
        uCool: { value: new THREE.Color(0x000000) },
        uProgress: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHot;
        uniform vec3 uCool;
        uniform float uProgress;
        varying vec2 vUv;

        // Cheap value noise, so the rim is ragged rather than a perfect circle. A geometric ring
        // reads as a decal; a broken one reads as burn.
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float d = length(p);
          float ragged = 0.82 + 0.18 * noise(p * 5.0);
          if (d > ragged) discard;
          float edge = smoothstep(ragged, ragged * 0.55, d);
          // The centre burns out first; the rim keeps glowing longest.
          float rim = smoothstep(ragged * 0.45, ragged * 0.95, d);
          // Cools fast and never gets near white: at pow(heat, 0.6) the mark spent most of its
          // life at the HOT colour, so a near-white hot colour made it a pale grey disc that
          // out-glowed the explosion that made it.
          float heat = pow(1.0 - uProgress, 2.6);
          vec3 colour = mix(uCool, uHot, pow(heat, 2.0));
          float alpha = edge * (0.12 + 0.5 * rim) * heat * 0.55;
          if (alpha <= 0.003) discard;
          gl_FragColor = vec4(colour * alpha, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.visible = false;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  get busy(): boolean { return this.active; }

  fire(at: THREE.Vector3, radius: number, hot: THREE.Color, cool: THREE.Color, duration = 1.4): void {
    this.mesh.position.copy(at);
    this.mesh.scale.set(radius * 2, radius * 2, 1);
    // Rotated per hit so repeated marks on the same spot do not stamp the same noise twice.
    this.mesh.rotation.z = Math.random() * Math.PI * 2;
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uHot.value.copy(hot);
    u.uCool.value.copy(cool);
    u.uProgress.value = 0;
    this.duration = duration;
    this.t = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  update(delta: number): void {
    if (!this.active) return;
    this.t += delta;
    const k = this.t / this.duration;
    if (k >= 1) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uProgress.value = k;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
