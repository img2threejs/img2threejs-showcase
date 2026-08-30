import * as THREE from 'three';

/**
 * The fracture a landed punch leaves in the air.
 *
 * `box_02` is a BOXING combination — three punches that connect at arm's length — and it was being
 * used to throw projectiles, which is why it never read right: the animation strikes something and
 * the effect flew away from it. A punch needs an impact AT the fist, and the readable signature of
 * an impact is a crack.
 *
 * The pattern is generated in the fragment shader, not drawn: spokes radiate from the centre at
 * hashed angles, each with its own length and its own slight wander, narrowing as it goes out.
 * Three sets at different spoke counts overlay to give primaries and finer branches. The whole
 * thing races outward over the first fifth of its life and then holds and fades, which is what a
 * fracture does — it propagates far faster than it disappears.
 *
 * It BILLBOARDS. A crack lying in the plane perpendicular to the punch is more physical, but this
 * character punches across the frame, so that plane is seen edge-on and the fracture would be
 * invisible from the one angle the demo is framed at. Fighting games billboard their impact art for
 * exactly this reason.
 */
export class Crack {
  readonly mesh: THREE.Mesh;
  private t = 0;
  private duration = 0.55;
  private active = false;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(0xffffff) },
        uCore: { value: new THREE.Color(0xffffff) },
        uProgress: { value: 0 },
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
        uniform vec3 uColour;
        uniform vec3 uCore;
        uniform float uProgress;
        uniform float uSeed;
        varying vec2 vUv;

        float hash(vec2 p) {
          p = mod(p, 128.0);
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        // One set of radiating fractures: spokes sets how many, reach how far they run.
        float fractures(float angle, float r, float spokes, float band, float reach, float grow) {
          float idx = floor(angle * spokes);
          float h = hash(vec2(idx, uSeed + band));
          float h2 = hash(vec2(idx + 31.0, uSeed + band));
          // Offset each spoke inside its slot so they are not evenly spaced.
          float centre = (idx + 0.25 + h * 0.5) / spokes;
          // Wander, so a crack is not a clean ray.
          centre += sin(r * (14.0 + h2 * 22.0) + h * 30.0) * 0.9 / spokes * 0.35;
          float d = abs(angle - centre);
          d = min(d, 1.0 - d);

          float run = reach * (0.35 + h2 * 0.65);
          // Angular half-width shrinks with radius so the crack tapers to a point.
          // Thin. At 0.55 the spokes were wide enough to merge into a disc, and the whole thing
          // read as a soft ball with a few filaments rather than as a fracture.
          float w = (0.5 / spokes) * (1.0 - r / max(run, 0.001)) * 0.28;
          float line = smoothstep(max(w, 0.0), w * 0.15, d);
          // Propagate outward, then taper away at the tip.
          line *= step(r, min(run, grow));
          line *= smoothstep(run, run * 0.35, r);
          return line;
        }

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;
          float angle = atan(p.y, p.x) / 6.2831853 + 0.5;

          // Cracks race out over the first fifth of the life, then hold.
          float grow = min(1.0, uProgress * 5.0);
          float fade = pow(1.0 - uProgress, 1.8);

          // Few long primaries, more short branches — the proportion real fractures have.
          float f = fractures(angle, r, 7.0, 0.0, 1.0, grow);
          f = max(f, fractures(angle, r, 15.0, 5.0, 0.55, grow) * 0.8);
          f = max(f, fractures(angle, r, 31.0, 11.0, 0.3, grow) * 0.55);

          // The struck point itself: a hard hot centre that dies faster than the cracks.
          // The struck point, kept well under the lines: the fracture is the read, not the flash.
          float core = pow(max(1.0 - r / 0.26, 0.0), 3.0) * pow(1.0 - uProgress, 3.5) * 0.24;

          float alpha = f * fade + core;
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(mix(uColour, uCore, core) * alpha, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  get busy(): boolean { return this.active; }

  fire(at: THREE.Vector3, radius: number, colour: THREE.Color, core: THREE.Color, duration = 0.55): void {
    this.mesh.position.copy(at);
    this.mesh.scale.set(radius * 2, radius * 2, 1);
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uColour.value.copy(colour);
    u.uCore.value.copy(core);
    u.uProgress.value = 0;
    u.uSeed.value = Math.floor(Math.random() * 90);
    this.duration = duration;
    this.t = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  update(delta: number, cameraPosition: THREE.Vector3): void {
    if (!this.active) return;
    this.t += delta;
    const k = this.t / this.duration;
    if (k >= 1) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uProgress.value = k;
    this.mesh.lookAt(cameraPosition);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
