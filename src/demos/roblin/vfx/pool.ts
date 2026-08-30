import * as THREE from 'three';

/**
 * A caustic pool: what bile leaves on the ground after it lands.
 *
 * The impacts used to leave a `Scorch` — a burn mark, which belongs to fire and therefore to no
 * part of this character. Roblin's damage is corrosive, so the residue is a puddle: it SPREADS
 * fast, holds while it eats at the floor, bubbles the whole time, and sinks away. Bubbles are the
 * detail that sells it — a static blob is a decal, a blob whose surface keeps breaking is alive.
 *
 * The bubbling is three layers of animated value noise thresholded against each other, so blisters
 * appear, grow and pop at different rates across the pool without a single texture being loaded.
 */
export class Pool {
  readonly mesh: THREE.Mesh;
  private t = 0;
  private duration = 3;
  private active = false;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSkin: { value: new THREE.Color(0xffffff) },
        uDeep: { value: new THREE.Color(0x000000) },
        uProgress: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSkin;
        uniform vec3 uDeep;
        uniform float uProgress;
        uniform float uTime;
        uniform float uSeed;
        varying vec2 vUv;

        // The coordinate is WRAPPED before hashing. sin() of a large argument loses precision
        // badly on some drivers and this hash then returns NaN — and NaN fails every comparison,
        // so the d > edge test was false everywhere and the discard never fired. It rendered as its
        // own bounding QUAD: a hard-edged square lying on the floor.
        float hash(vec2 p) {
          p = mod(p, 128.0);
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          vec2 q = p + vec2(uSeed, uSeed * 1.7);
          float d = length(p);

          // Spreads quickly, then holds. A pool that grows at a constant rate reads as a circle
          // being scaled; real spill is nearly all over in the first moments.
          float spread = min(1.0, pow(uProgress * 5.0, 0.55));
          float rim = clamp(0.55 + 0.45 * noise(q * 3.5), 0.3, 1.0);
          float edge = rim * spread;
          if (d > edge) discard;

          // Three bubble layers at different speeds, thresholded so blisters pop rather than pulse.
          float b1 = noise(q * 7.0 + vec2(0.0, uTime * 0.5));
          float b2 = noise(q * 13.0 - vec2(uTime * 0.35, 0.0));
          float b3 = noise(q * 22.0 + vec2(uTime * 0.8, -uTime * 0.6));
          float bubble = smoothstep(0.62, 0.86, b1 * 0.5 + b2 * 0.3 + b3 * 0.2);

          // NOT smoothstep(edge, edge*0.2, d): GLSL leaves smoothstep undefined when edge0 > edge1,
          // and drivers differ on what it returns.
          float body = 1.0 - smoothstep(edge * 0.2, edge, d);
          // The rim of a corrosive pool is its brightest part — that is where it is still working.
          float lip = smoothstep(edge * 0.72, edge * 0.98, d);

          // Sinks away over the back half of its life rather than fading uniformly.
          float alive = 1.0 - smoothstep(0.45, 1.0, uProgress);

          vec3 colour = uDeep * body * 0.5 + uSkin * (lip * 0.85 + bubble * 0.7);
          float alpha = body * alive * (0.28 + 0.72 * max(lip, bubble));
          if (alpha <= 0.004) discard;
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

  fire(at: THREE.Vector3, radius: number, skin: THREE.Color, deep: THREE.Color, duration = 3): void {
    this.mesh.position.copy(at);
    this.mesh.scale.set(radius * 2, radius * 2, 1);
    this.mesh.rotation.z = Math.random() * Math.PI * 2;
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uSkin.value.copy(skin);
    u.uDeep.value.copy(deep);
    u.uProgress.value = 0;
    // Small on purpose — see the hash comment in the shader.
    u.uSeed.value = Math.random() * 4;
    this.duration = duration;
    this.t = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  update(delta: number): void {
    if (!this.active) return;
    this.t += delta;
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value += delta;
    const k = this.t / this.duration;
    if (k >= 1) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    u.uProgress.value = k;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
