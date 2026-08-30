/**
 * A motion trail that follows a socket.
 *
 * HAND-WRITTEN — see the note in `particles.ts`.
 *
 * A ribbon rather than a line: a `THREE.Line` is one pixel wide whatever you ask of it on most
 * platforms, so a trail built from lines vanishes at distance. This builds a camera-facing strip
 * whose width tapers to nothing at the tail, which is what makes a fast hand read as fast.
 *
 * The strip is a fixed-size buffer written in place. Nothing is allocated per frame.
 */
import * as THREE from 'three';

const VERTEX = /* glsl */ `
  attribute float aFade;
  attribute float aSide;
  varying float vFade;
  varying float vSide;
  void main() {
    vFade = aFade;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying float vSide;
  void main() {
    // Feathered across the ribbon as well as along it. With a hard edge the strip reads as a sheet
    // lying on whatever is behind it; with a soft one it reads as light.
    float across = 1.0 - vSide * vSide;
    // vFade^1.5 rather than squared: squaring crushed the tail to nothing and the trail read
    // as a short blob at the wrist instead of a streak.
    gl_FragColor = vec4(uColor * (0.6 + 0.7 * vFade), pow(vFade, 1.6) * across * uOpacity * 0.75);
  }
`;

export class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly samples: THREE.Vector3[];
  private readonly positions: Float32Array;
  private readonly fades: Float32Array;
  private readonly sides: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private readonly width: number;
  private filled = 0;
  private strength = 0;

  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpToCamera = new THREE.Vector3();
  private readonly tmpSide = new THREE.Vector3();

  constructor(segments: number, width: number, colour: THREE.Color) {
    this.width = width;
    this.samples = Array.from({ length: segments }, () => new THREE.Vector3());
    this.positions = new Float32Array(segments * 2 * 3);
    this.fades = new Float32Array(segments * 2);
    this.sides = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i += 1) { this.sides[i * 2] = -1; this.sides[i * 2 + 1] = 1; }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aFade', new THREE.BufferAttribute(this.fades, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(this.sides, 1));
    // Two triangles per segment pair, wound as a strip laid out by hand so the index buffer is
    // static and only the vertex positions move.
    const index: number[] = [];
    for (let i = 0; i < segments - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uColor: { value: colour.clone() }, uOpacity: { value: 0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
  }

  get opacity(): number { return this.material.uniforms.uOpacity.value as number; }

  setColour(colour: THREE.Color): void { (this.material.uniforms.uColor.value as THREE.Color).copy(colour); }

  /** 0 hides the trail, 1 is full strength. Ramped rather than switched so it does not pop. */
  setStrength(value: number): void { this.strength = value; }

  /** Drop the history so the next frame does not draw a streak from wherever the socket used to be. */
  reset(): void { this.filled = 0; this.mesh.visible = false; }

  update(tip: THREE.Vector3, cameraPosition: THREE.Vector3, dt: number): void {
    const opacity = this.material.uniforms.uOpacity.value as number;
    const target = this.strength;
    // Ramp over ~0.15 s. Switching a trail on instantly draws its whole history in one frame.
    this.material.uniforms.uOpacity.value = opacity + (target - opacity) * Math.min(1, dt * 7);

    if (this.material.uniforms.uOpacity.value < 0.01 && target === 0) { this.reset(); return; }

    // Push the newest sample to the front, shifting the rest back by one.
    for (let i = this.samples.length - 1; i > 0; i -= 1) this.samples[i].copy(this.samples[i - 1]);
    this.samples[0].copy(tip);
    if (this.filled < this.samples.length) this.filled += 1;
    if (this.filled < 3) { this.mesh.visible = false; return; }

    /**
     * Only the segments that actually exist are drawn.
     *
     * The history refills from zero after every reset — and it resets on each clip change, and
     * again whenever the hand slows enough for the trail to fade out. While it was refilling, every
     * vertex past `filled` clamped onto the SAME oldest sample but kept its own tapering width, so
     * the tail collapsed into a single point and the strip fanned out from it as one large
     * triangle. Against the pale belly that fan read as a hard-edged translucent wedge — exactly
     * like a tear in the mesh, which is what it was mistaken for. Shrinking the draw range to the
     * real segments removes it at the source; there is nothing to clamp.
     */
    const live = this.filled;
    for (let i = 0; i < live; i += 1) {
      const here = this.samples[i];
      const ahead = this.samples[Math.max(0, i - 1)];
      const behind = this.samples[Math.min(live - 1, i + 1)];
      this.tmpDir.subVectors(ahead, behind);
      if (this.tmpDir.lengthSq() < 1e-12) this.tmpDir.set(0, 1, 0);
      this.tmpToCamera.subVectors(cameraPosition, here);
      // Perpendicular to both the trail's direction and the view: the strip always faces the camera.
      this.tmpSide.crossVectors(this.tmpDir, this.tmpToCamera);
      if (this.tmpSide.lengthSq() < 1e-12) this.tmpSide.set(1, 0, 0);
      this.tmpSide.normalize();

      // Taper over the samples that exist, not over the buffer's capacity, so a half-filled trail
      // still reaches zero width at its own tail instead of ending abruptly mid-width.
      const age = i / (live - 1);
      const halfWidth = (this.width * (1 - age) ** 1.5) / 2;
      const fade = (1 - age) ** 1.5;

      this.positions[i * 6] = here.x + this.tmpSide.x * halfWidth;
      this.positions[i * 6 + 1] = here.y + this.tmpSide.y * halfWidth;
      this.positions[i * 6 + 2] = here.z + this.tmpSide.z * halfWidth;
      this.positions[i * 6 + 3] = here.x - this.tmpSide.x * halfWidth;
      this.positions[i * 6 + 4] = here.y - this.tmpSide.y * halfWidth;
      this.positions[i * 6 + 5] = here.z - this.tmpSide.z * halfWidth;
      this.fades[i * 2] = fade;
      this.fades[i * 2 + 1] = fade;
    }

    const geometry = this.mesh.geometry;
    geometry.setDrawRange(0, (live - 1) * 6);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aFade') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); }
}
