import * as THREE from 'three';
import { Ribbon } from './ribbon';
import type { ParticleField } from './particles';

/**
 * A ranged bolt: core, halo, moving light, ribbon wake and a trail of sparks.
 *
 * HAND-WRITTEN, like everything in this folder. The pieces are deliberate:
 *   - a small opaque CORE, so the bolt has a shape at bloom threshold instead of a smear;
 *   - a HALO at roughly three times the core radius on additive back-side rendering, which is what
 *     sells "this thing is emitting" without a volumetric;
 *   - a POINT LIGHT that travels with it, so the bolt lights the figure it just left and the floor
 *     it is about to hit. This is the part a purely additive effect cannot fake;
 *   - a RIBBON wake plus per-frame spark emission into the shared particle field.
 *
 * A bolt is pooled and reused; nothing is allocated once the pool is warm.
 */

export interface BoltOptions {
  from: THREE.Vector3;
  /** Unit direction of travel. */
  direction: THREE.Vector3;
  /** World units per second. */
  speed: number;
  /** Distance before it detonates on its own. */
  range: number;
  core: THREE.Color;
  halo: THREE.Color;
  radius: number;
  /** Sparks emitted per second along the flight. */
  sparkRate: number;
  /**
   * Multiplier on the travelling light. A volley or a radial burst puts many bolts in the same
   * place at once, and eight full-strength lights at one point white out the frame — so a skill
   * that fires many bolts turns this down rather than turning the bolts down.
   */
  lightScale?: number;
  /** Called at the point of impact, with the impact position. */
  onImpact?(at: THREE.Vector3, direction: THREE.Vector3): void;
}

class Bolt {
  readonly group = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private readonly ribbon: Ribbon;
  private readonly velocity = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private travelled = 0;
  private range = 0;
  private sparkRate = 0;
  private sparkDebt = 0;
  private sparkColour = new THREE.Color();
  private radius = 0.1;
  private onImpact: BoltOptions['onImpact'];
  private state: 'idle' | 'flying' | 'fading' = 'idle';
  private fade = 0;

  constructor(private readonly field: ParticleField) {
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    // A SHADED halo, not a flat additive sphere.
    //
    // The first version was a MeshBasicMaterial sphere on additive back-side rendering. Under the
    // standalone build's bloom pass that reads as a glow, because bloom supplies the falloff. The
    // gallery viewer renders without post-processing, and there the same sphere is a hard-edged
    // flat disc — the glow was being done by the bloom, not by the effect.
    //
    // So the falloff is in the material now. Rendered back-side, the fragment at the middle of the
    // sphere is its far wall and its normal points away from the camera, while the rim's normal is
    // perpendicular to the view. `-dot(N, V)` is therefore 1 at the centre and 0 at the edge, which
    // is the orb profile, and it costs one dot product.
    this.halo = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 3),
      new THREE.ShaderMaterial({
        uniforms: { uColour: { value: new THREE.Color(0xffffff) }, uStrength: { value: 0.85 } },
        vertexShader: /* glsl */ `
          varying vec3 vNormalView;
          varying vec3 vViewDir;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vNormalView = normalMatrix * normal;
            vViewDir = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColour;
          uniform float uStrength;
          varying vec3 vNormalView;
          varying vec3 vViewDir;
          void main() {
            float facing = -dot(normalize(vNormalView), normalize(vViewDir));
            float core = pow(clamp(facing, 0.0, 1.0), 2.6);
            float skirt = pow(clamp(facing, 0.0, 1.0), 0.9) * 0.35;
            gl_FragColor = vec4(uColour * (core + skirt) * uStrength, 1.0);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // Back side only: the front faces would otherwise double the core's brightness and flatten it.
        side: THREE.BackSide,
      }),
    );
    this.light = new THREE.PointLight(0xffffff, 0, 6, 2);
    // 26 segments at this speed laid down four units of additive ribbon, which bloom welded
    // into one continuous white beam with the core invisible inside it.
    this.ribbon = new Ribbon(14, 0.1, new THREE.Color(0xffffff));
    this.group.add(this.core, this.halo, this.light);
    this.group.visible = false;
  }

  get ribbonMesh(): THREE.Mesh { return this.ribbon.mesh; }
  get busy(): boolean { return this.state !== 'idle'; }

  launch(options: BoltOptions): void {
    const { from, direction, speed, range, core, halo, radius, sparkRate, onImpact, lightScale = 1 } = options;
    this.group.position.copy(from);
    this.start.copy(from);
    this.direction.copy(direction).normalize();
    this.velocity.copy(this.direction).multiplyScalar(speed);
    this.travelled = 0;
    this.range = range;
    this.radius = radius;
    this.sparkRate = sparkRate;
    this.sparkDebt = 0;
    this.sparkColour.copy(halo);
    this.onImpact = onImpact;

    // The halo has to stay clearly dimmer than the core. At 3.1x and 0.42 opacity it and the core
    // both clipped to white after tone mapping and bloom, and the bolt lost its shape — it read as
    // a flat disc rather than as a hot centre inside a glow.
    this.core.scale.setScalar(radius * 0.78);
    this.halo.scale.setScalar(radius * 3.0);
    (this.core.material as THREE.MeshBasicMaterial).color.copy(core);
    (this.halo.material as THREE.ShaderMaterial).uniforms.uColour.value.copy(halo);
    this.light.color.copy(halo);
    // Tied to the bolt's own size so a volley pellet does not light the stage like the heavy bolt.
    // Measured down from 7 + 70r: at that strength the bolt's own light washed the figure to near
    // white as it passed, which the bloom pass had been hiding in the standalone build.
    this.light.intensity = (5 + radius * 46) * lightScale;
    this.light.distance = radius * 27;
    this.ribbon.setWidth(radius * 1.25);
    this.ribbon.setColour(halo);
    this.ribbon.setOpacity(0.55);
    this.ribbon.reset(from);
    this.group.visible = true;
    this.state = 'flying';
    this.fade = 0;
  }

  update(delta: number, cameraPosition: THREE.Vector3): void {
    if (this.state === 'idle') return;

    if (this.state === 'fading') {
      // The bolt is gone but its wake is not; fade the ribbon out rather than deleting it mid-air.
      this.fade += delta;
      this.ribbon.fade(delta * 3.4);
      this.ribbon.build(cameraPosition);
      if (this.fade > 0.42) {
        this.state = 'idle';
        this.ribbon.setOpacity(0);
      }
      return;
    }

    const step = this.velocity.clone().multiplyScalar(delta);
    this.group.position.add(step);
    this.travelled += step.length();
    this.ribbon.push(this.group.position);
    this.ribbon.build(cameraPosition);

    // Spin the core so the facets catch the light and the bolt does not read as a static ball.
    this.core.rotation.x += delta * 7;
    this.core.rotation.y += delta * 5;

    this.sparkDebt += this.sparkRate * delta;
    const sparks = Math.floor(this.sparkDebt);
    if (sparks > 0) {
      this.sparkDebt -= sparks;
      this.field.emit({
        position: this.group.position,
        direction: this.direction.clone().negate(),
        spread: 0.85,
        count: sparks,
        speed: [0.4, 1.9],
        life: [0.16, 0.42],
        size: [this.radius * 2, this.radius * 6],
        colour: this.sparkColour,
        colourEnd: this.sparkColour.clone().multiplyScalar(0.25),
        gravity: 1.1,
        drag: 2.6,
        jitter: this.radius * 0.6,
      });
    }

    if (this.travelled >= this.range) this.detonate();
  }

  private detonate(): void {
    this.onImpact?.(this.group.position.clone(), this.direction.clone());
    this.group.visible = false;
    this.light.intensity = 0;
    this.state = 'fading';
    this.fade = 0;
  }

  dispose(): void {
    this.core.geometry.dispose();
    this.halo.geometry.dispose();
    (this.core.material as THREE.Material).dispose();
    (this.halo.material as THREE.Material).dispose();
    this.ribbon.dispose();
  }
}

/** Fixed-size pool. A request with no free bolt is dropped rather than allocating mid-cast. */
export class BoltPool {
  private readonly bolts: Bolt[];
  readonly group = new THREE.Group();

  constructor(field: ParticleField, size = 12) {
    this.bolts = Array.from({ length: size }, () => new Bolt(field));
    this.group.name = 'roblin-bolts';
    for (const bolt of this.bolts) this.group.add(bolt.group, bolt.ribbonMesh);
  }

  launch(options: BoltOptions): boolean {
    const free = this.bolts.find((b) => !b.busy);
    if (!free) return false;
    free.launch(options);
    return true;
  }

  get flying(): number { return this.bolts.filter((b) => b.busy).length; }

  update(delta: number, cameraPosition: THREE.Vector3): void {
    for (const bolt of this.bolts) bolt.update(delta, cameraPosition);
  }

  dispose(): void {
    for (const bolt of this.bolts) bolt.dispose();
  }
}
