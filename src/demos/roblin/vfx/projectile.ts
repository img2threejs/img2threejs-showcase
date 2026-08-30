import * as THREE from 'three';
import { Ribbon } from './ribbon';
import { globGeometry, globMaterial, type GlobStyle } from './glob';
import type { ParticleField } from './particles';

/** The axis a glob's long profile is built on, before it is aimed down its own velocity. */
const FORWARD = new THREE.Vector3(0, 0, 1);

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
  /** Wake colour at the head. Defaults to `halo`. */
  trailHead?: THREE.Color;
  /**
   * Wake colour at the tail. Fire is white-hot where it leaves the fist and dull red where it has
   * had time to cool; a single flat colour along the wake is what made the ember trail read as a
   * plastic tube. Defaults to `halo`, which reproduces the old single-colour behaviour.
   */
  trailTail?: THREE.Color;
  /** Colour the shed sparks cool to. Defaults to a dimmed `halo`. */
  sparkEnd?: THREE.Color;
  /** Downward acceleration on the shed sparks. NEGATIVE makes embers rise off the trail. */
  sparkGravity?: number;
  /** 0 steady, 1 guttering. Applies to the shed sparks and to the core's own brightness. */
  flicker?: number;
  /** Multiplies the shed spark size. */
  sparkSize?: number;
  /**
   * What the projectile IS. 'gel' is a lumpy sac of bile, 'shard' a piece of scavenged scrap,
   * 'orb' the original smooth magic sphere. See glob.ts.
   */
  style?: GlobStyle | 'orb';
  /** Deep colour inside the glob; the skin colour is `core`. */
  deep?: THREE.Color;
  /** Called at the point of impact, with the impact position. */
  onImpact?(at: THREE.Vector3, direction: THREE.Vector3): void;
}

class Bolt {
  readonly group = new THREE.Group();
  private core: THREE.Mesh;
  private readonly orbCore: THREE.Mesh;
  private readonly gelCore: THREE.Mesh;
  private readonly shardCore: THREE.Mesh;
  private style: GlobStyle | 'orb' = 'orb';
  private readonly halo: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private readonly ribbon: Ribbon;
  private readonly velocity = new THREE.Vector3();
  private baseIntensity = 0;
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
  private sparkEnd = new THREE.Color();
  private sparkGravity = 1.1;
  private sparkSize = 1;
  private flicker = 0;
  private coreColour = new THREE.Color();
  private life = 0;

  constructor(private readonly field: ParticleField, variant = 0) {
    // Three bodies, swapped by style rather than rebuilt: allocating geometry mid-cast is exactly
    // the frame-time spike the pooling exists to avoid.
    this.orbCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    this.gelCore = new THREE.Mesh(globGeometry('gel', variant), globMaterial('gel'));
    this.shardCore = new THREE.Mesh(globGeometry('shard', variant), globMaterial('shard'));
    this.core = this.orbCore;
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
    this.group.add(this.orbCore, this.gelCore, this.shardCore, this.halo, this.light);
    this.gelCore.visible = false;
    this.shardCore.visible = false;
    this.group.visible = false;
  }

  get ribbonMesh(): THREE.Mesh { return this.ribbon.mesh; }
  get busy(): boolean { return this.state !== 'idle'; }

  launch(options: BoltOptions): void {
    const {
      from, direction, speed, range, core, halo, radius, sparkRate, onImpact, lightScale = 1,
      trailHead = halo, trailTail = halo, sparkEnd, sparkGravity = 1.1, flicker = 0, sparkSize = 1,
      style = 'orb', deep,
    } = options;
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
    this.sparkEnd.copy(sparkEnd ?? halo.clone().multiplyScalar(0.25));
    this.sparkGravity = sparkGravity;
    this.sparkSize = sparkSize;
    this.flicker = flicker;
    this.coreColour.copy(core);
    this.life = 0;
    this.onImpact = onImpact;

    // The halo has to stay clearly dimmer than the core. At 3.1x and 0.42 opacity it and the core
    // both clipped to white after tone mapping and bloom, and the bolt lost its shape — it read as
    // a flat disc rather than as a hot centre inside a glow.
    this.style = style;
    this.orbCore.visible = style === 'orb';
    this.gelCore.visible = style === 'gel';
    this.shardCore.visible = style === 'shard';
    this.core = style === 'gel' ? this.gelCore : style === 'shard' ? this.shardCore : this.orbCore;

    if (style === 'orb') {
      this.core.scale.setScalar(radius * 0.78);
      (this.core.material as THREE.MeshBasicMaterial).color.copy(core);
    } else {
      // Squashed along its own travel: a thrown droplet and a spinning shard both present a longer
      // profile down the direction they are going, and a perfect sphere is the one shape that
      // cannot show which way it is moving.
      const stretch = style === 'gel' ? 1.55 : 1.9;
      this.core.scale.set(radius * 0.9, radius * 0.9, radius * 0.9 * stretch);
      this.core.quaternion.setFromUnitVectors(FORWARD, this.direction);
      const u = (this.core.material as THREE.ShaderMaterial).uniforms;
      u.uSkin.value.copy(core);
      u.uDeep.value.copy(deep ?? halo);
      u.uGlow.value = 1;
    }
    // A gel glob is its own bright object and needs far less additive halo than a magic orb, which
    // was nothing BUT halo. Stacking the orb's halo on top of it is what blew the first version out.
    this.halo.scale.setScalar(radius * (style === 'orb' ? 3.0 : style === 'shard' ? 1.9 : 2.1));
    (this.halo.material as THREE.ShaderMaterial).uniforms.uStrength.value = style === 'orb' ? 0.85 : 0.4;
    (this.halo.material as THREE.ShaderMaterial).uniforms.uColour.value.copy(halo);
    this.light.color.copy(halo);
    // Tied to the bolt's own size so a volley pellet does not light the stage like the heavy bolt.
    // Measured down from 7 + 70r: at that strength the bolt's own light washed the figure to near
    // white as it passed, which the bloom pass had been hiding in the standalone build.
    this.baseIntensity = (5 + radius * 46) * lightScale * (style === 'gel' ? 0.6 : 1);
    this.light.intensity = this.baseIntensity;
    this.light.distance = radius * 27;
    this.ribbon.setWidth(radius * 1.25);
    this.ribbon.setColours(trailHead, trailTail);
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

    // Tumble. Bile wallows; scrap spins hard. The orb keeps the old constant spin.
    const tumble = this.style === 'gel' ? 2.2 : this.style === 'shard' ? 16 : 7;
    this.core.rotateX(delta * tumble);
    this.core.rotateZ(delta * tumble * 0.62);

    if (this.style !== 'orb') {
      // Wobble the glob's brightness slowly — a sac of liquid catches the light unevenly as it
      // turns. Separate from `flicker`, which is the fast guttering a flame does.
      const u = (this.core.material as THREE.ShaderMaterial).uniforms;
      this.life += delta;
      u.uGlow.value = 0.82 + 0.18 * Math.sin(this.life * 9.5);
    }

    if (this.flicker > 0) {
      // The core guts like a flame rather than burning at a constant brightness. Two detuned
      // sines, the same trick the ember particles use, so it never falls into an obvious beat.
      this.life += delta;
      const gutter = 0.72 + 0.28
        * (0.5 + 0.5 * Math.sin(this.life * 21)) * (0.6 + 0.4 * Math.sin(this.life * 7.7));
      const k = 1 - this.flicker + this.flicker * gutter;
      if (this.style === 'orb') {
        (this.core.material as THREE.MeshBasicMaterial).color.copy(this.coreColour).multiplyScalar(k);
      }
      (this.halo.material as THREE.ShaderMaterial).uniforms.uStrength.value = 0.85 * k;
      this.light.intensity = this.baseIntensity * k;
    }

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
        size: [this.radius * 2 * this.sparkSize, this.radius * 6 * this.sparkSize],
        colour: this.sparkColour,
        colourEnd: this.sparkEnd,
        gravity: this.sparkGravity,
        drag: 2.6,
        jitter: this.radius * 0.6,
        flicker: this.flicker,
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
    // Glob geometries are shared out of a cache and are NOT disposed here.
    this.orbCore.geometry.dispose();
    this.halo.geometry.dispose();
    for (const mesh of [this.orbCore, this.gelCore, this.shardCore]) {
      (mesh.material as THREE.Material).dispose();
    }
    (this.halo.material as THREE.Material).dispose();
    this.ribbon.dispose();
  }
}

/** Fixed-size pool. A request with no free bolt is dropped rather than allocating mid-cast. */
export class BoltPool {
  private readonly bolts: Bolt[];
  readonly group = new THREE.Group();

  constructor(field: ParticleField, size = 12) {
    // Each bolt gets its own deformation variant, so a volley is three different lumps.
    this.bolts = Array.from({ length: size }, (_, i) => new Bolt(field, i));
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
