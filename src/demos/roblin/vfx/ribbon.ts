import * as THREE from 'three';

/**
 * A camera-facing ribbon trail.
 *
 * HAND-WRITTEN — three has no trail renderer. The ribbon is a fixed-length strip of quads whose
 * spine is a ring buffer of the positions the emitter passed through. Each frame the strip is
 * re-extruded perpendicular to both the spine direction and the view direction, which is what
 * keeps a flat ribbon from vanishing when it turns edge-on to the camera.
 */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly points: THREE.Vector3[];
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private count = 0;
  private width: number;

  constructor(segments: number, width: number, colour: THREE.Color, opacity = 1) {
    this.width = width;
    this.points = Array.from({ length: segments }, () => new THREE.Vector3());
    this.positions = new Float32Array(segments * 2 * 3);
    this.alphas = new Float32Array(segments * 2);

    const index: number[] = [];
    for (let i = 0; i < segments - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setIndex(index);
    this.geometry = geometry;

    const material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: colour.clone() }, uOpacity: { value: opacity } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColour;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(uColour * vAlpha * uOpacity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  /** Trail width follows the emitter's size; a fixed width turns a small bolt into a laser. */
  setWidth(width: number): void {
    this.width = width;
  }

  setColour(colour: THREE.Color): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uColour.value.copy(colour);
  }

  /** Start a fresh trail at a point — clears the spine so the ribbon does not snap across the scene. */
  reset(at: THREE.Vector3): void {
    for (const p of this.points) p.copy(at);
    this.count = this.points.length;
    this.mesh.visible = true;
  }

  /** Push the newest position. Call once per frame while the emitter moves. */
  push(at: THREE.Vector3): void {
    for (let i = this.points.length - 1; i > 0; i -= 1) this.points[i].copy(this.points[i - 1]);
    this.points[0].copy(at);
    this.count = this.points.length;
  }

  /** Fade the whole ribbon out over `seconds`, without moving it. */
  fade(amount: number): void {
    const material = this.mesh.material as THREE.ShaderMaterial;
    material.uniforms.uOpacity.value = Math.max(0, material.uniforms.uOpacity.value - amount);
    if (material.uniforms.uOpacity.value <= 0) this.mesh.visible = false;
  }

  setOpacity(value: number): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = value;
    this.mesh.visible = value > 0;
  }

  /** Re-extrude the strip. `cameraPosition` is what keeps the ribbon facing the viewer. */
  build(cameraPosition: THREE.Vector3): void {
    if (this.count < 2) return;
    const dir = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const side = new THREE.Vector3();
    const n = this.points.length;

    for (let i = 0; i < n; i += 1) {
      const here = this.points[i];
      const next = this.points[Math.min(i + 1, n - 1)];
      const prev = this.points[Math.max(i - 1, 0)];
      dir.subVectors(next, prev);
      if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
      toCamera.subVectors(cameraPosition, here);
      side.crossVectors(dir, toCamera);
      if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
      // Taper to a point at the tail so the ribbon reads as a wake, not a flat plank.
      const t = i / (n - 1);
      const halfWidth = this.width * 0.5 * (1 - t) ** 0.7;
      side.normalize().multiplyScalar(halfWidth);

      const a = i * 6;
      this.positions[a] = here.x - side.x;
      this.positions[a + 1] = here.y - side.y;
      this.positions[a + 2] = here.z - side.z;
      this.positions[a + 3] = here.x + side.x;
      this.positions[a + 4] = here.y + side.y;
      this.positions[a + 5] = here.z + side.z;
      const alpha = (1 - t) ** 1.6;
      this.alphas[i * 2] = alpha;
      this.alphas[i * 2 + 1] = alpha;
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
