import * as THREE from 'three';
import { createRng } from './rng';

/**
 * The flies that follow Roblin around.
 *
 * The idle used to be rising motes — clean, upward, magical. It made a barefoot goblin in rotting
 * leather look like he was ascending. This is the opposite reading of the same character: a loose
 * swarm of gnats orbiting him, darting, never settling, thickening when he moves.
 *
 * Each gnat integrates a small wander force toward a slowly-drifting personal target inside a
 * bounding ellipsoid around the figure, which is what produces the nervous, non-repeating darting
 * that a sine-wave orbit cannot. They are drawn dark and small with a faint toxic sheen — visible
 * against the figure, nearly invisible against the black backdrop, exactly like real gnats.
 */
export class Swarm {
  readonly points: THREE.Points;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly target: Float32Array;
  private readonly retarget: Float32Array;
  private readonly count: number;
  private readonly rng = createRng(0x5faa17);
  private readonly centre = new THREE.Vector3();
  private readonly radii = new THREE.Vector3(1, 1, 1);
  private agitation = 0;

  constructor(count: number, size: number, colour: THREE.Color) {
    this.count = count;
    this.position = new Float32Array(count * 3);
    this.velocity = new Float32Array(count * 3);
    this.target = new Float32Array(count * 3);
    this.retarget = new Float32Array(count);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i += 1) sizes[i] = size * this.rng.range(0.55, 1.4);
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: colour.clone() }, uScale: { value: 320 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColour;
        uniform float uOpacity;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          if (dot(d, d) > 0.25) discard;
          gl_FragColor = vec4(uColour * uOpacity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'roblin-swarm';
    this.points.renderOrder = 3;
  }

  setViewportHeight(pixels: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = pixels * 0.32;
  }

  /** Ellipsoid the swarm keeps to, in world space. */
  setBounds(centre: THREE.Vector3, radii: THREE.Vector3): void {
    this.centre.copy(centre);
    this.radii.copy(radii);
  }

  /** 0 resting, 1 stirred up. A cast or a sprint scatters them. */
  stir(amount: number): void {
    this.agitation = Math.max(this.agitation, amount);
  }

  update(delta: number): void {
    const dt = Math.min(delta, 1 / 20);
    this.agitation = Math.max(0, this.agitation - dt * 1.1);
    const speed = 1.4 + this.agitation * 4.5;
    const turn = 5 + this.agitation * 9;

    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      this.retarget[i] -= dt;
      if (this.retarget[i] <= 0) {
        // A new destination every fifth of a second or so, which is what makes the path jagged.
        this.retarget[i] = this.rng.range(0.12, 0.4);
        this.target[i3] = this.centre.x + this.rng.spread(this.radii.x);
        this.target[i3 + 1] = this.centre.y + this.rng.spread(this.radii.y);
        this.target[i3 + 2] = this.centre.z + this.rng.spread(this.radii.z);
      }
      for (let k = 0; k < 3; k += 1) {
        const toTarget = this.target[i3 + k] - this.position[i3 + k];
        this.velocity[i3 + k] += toTarget * turn * dt;
        this.velocity[i3 + k] *= Math.max(0, 1 - 3.2 * dt);
        this.position[i3 + k] += this.velocity[i3 + k] * speed * dt;
      }
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.5 + this.agitation * 0.5;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
