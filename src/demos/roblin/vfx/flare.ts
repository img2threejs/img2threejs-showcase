import * as THREE from 'three';

/**
 * A directional muzzle flare — a brief flash that has an ORIENTATION.
 *
 * HAND-WRITTEN. A point light and a puff of particles say something bright happened; neither says
 * which way it went. This is a camera-facing quad stretched along the aim direction, so the flash
 * itself reads as a discharge leaving the hand along the hand's own axis. It is the cheapest way to
 * put direction into a single frame, and a single frame is all a muzzle flash gets.
 *
 * The quad billboards to the camera but keeps its long axis locked to the aim: the local x axis is
 * the aim projected into the view plane, and y is the perpendicular. A plain billboard would spin
 * the streak with the camera; a plain oriented quad would vanish edge-on.
 */
export class Flare {
  readonly mesh: THREE.Mesh;
  private t = 0;
  private duration = 0.12;
  private active = false;
  private readonly aim = new THREE.Vector3(1, 0, 0);
  private length = 1;
  private girth = 1;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(0xffffff) },
        uFade: { value: 0 },
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
        uniform float uFade;
        varying vec2 vUv;
        void main() {
          // A teardrop: hot and wide at the muzzle, tapering away down the aim.
          vec2 p = vUv * 2.0 - 1.0;
          float along = clamp(p.x * 0.5 + 0.5, 0.0, 1.0);
          float taper = pow(1.0 - along, 1.6);
          float across = 1.0 - min(1.0, abs(p.y) / max(taper, 0.02));
          float body = pow(max(across, 0.0), 1.8) * taper;
          float core = pow(max(1.0 - length(vec2(p.x * 1.6 + 0.9, p.y * 2.4)), 0.0), 2.0);
          float alpha = (body * 0.85 + core) * uFade;
          if (alpha <= 0.003) discard;
          gl_FragColor = vec4(uColour * alpha, 1.0);
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

  fire(
    at: THREE.Vector3,
    aim: THREE.Vector3,
    colour: THREE.Color,
    length: number,
    girth: number,
    duration = 0.13,
  ): void {
    this.mesh.position.copy(at);
    this.aim.copy(aim).normalize();
    this.length = length;
    this.girth = girth;
    this.duration = duration;
    this.t = 0;
    this.active = true;
    this.mesh.visible = true;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uColour.value.copy(colour);
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = 1;
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
    // Flash then die: a muzzle flare that fades linearly reads as a lamp, not a discharge.
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = (1 - k) ** 2.2;
    // Stretch a little as it dies, so the flash reads as expanding gas.
    this.mesh.scale.set(this.length * (1 + k * 0.5), this.girth * (1 + k * 0.9), 1);

    // Billboard about the aim: x follows the aim inside the view plane, z faces the camera.
    const toCamera = _v1.subVectors(cameraPosition, this.mesh.position).normalize();
    const x = _v2.copy(this.aim).addScaledVector(toCamera, -this.aim.dot(toCamera));
    if (x.lengthSq() < 1e-8) {
      // Aimed straight at the camera: any perpendicular will do, and the flare is a disc anyway.
      x.set(toCamera.y, -toCamera.x, 0);
      if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
    }
    x.normalize();
    const y = _v3.crossVectors(toCamera, x).normalize();
    _m.makeBasis(x, y, toCamera);
    this.mesh.quaternion.setFromRotationMatrix(_m);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
