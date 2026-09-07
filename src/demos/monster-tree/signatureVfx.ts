import * as THREE from 'three';
import { PALETTE } from './measured';

interface SignatureRig {
  group: THREE.Object3D;
  sockets: Record<string, THREE.Object3D>;
  bones: Record<string, THREE.Bone>;
}

/**
 * Groot's signature living-wood effects.
 *
 * The older layer was a collection of rings, decals and point bursts. Those ingredients were
 * technically attached to the rig, but their motion did not describe the force in the animation:
 * the lash ended in a white spot, the ground spell happened several metres away, and the passive
 * surrounded the feet with a wireframe lawn. This layer is deliberately smaller and more legible:
 *
 * - living bark carries a pale sap core from the throwing hand to a fixed target;
 * - contact arrests the line with a directional crown of wood splinters;
 * - a two-handed slam rolls a wedge of roots away from the hands that hit the floor;
 * - the passive draws sparse sap motes from visible roots into the chest;
 * - the ultimate holds warm seeds in a canopy, using the leather hue as the one contrast accent.
 *
 * Every geometry, material, typed array and pool slot is allocated in the constructor. Runtime
 * cues only reset numbers and stream matrices/attributes. Every object also starts invisible so a
 * framing pass can never measure an effect.
 */

const SAP = new THREE.Color(PALETTE.eyeCore);
const LIFE = new THREE.Color(PALETTE.eyeIris).multiplyScalar(1.08);
const DEEP = new THREE.Color(PALETTE.eyeDeep);
const BARK_LIT = new THREE.Color(PALETTE.barkLight);
const SEED = new THREE.Color(PALETTE.leatherLight).multiplyScalar(1.32);
const SEED_SHELL = new THREE.Color(PALETTE.leatherDark).multiplyScalar(0.82);

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const SEG_A = new THREE.Vector3();
const SEG_B = new THREE.Vector3();
const SEG_MID = new THREE.Vector3();
const SEG_DIR = new THREE.Vector3();
const SEG_SCALE = new THREE.Vector3();
const SEG_Q = new THREE.Quaternion();
const SEG_M = new THREE.Matrix4();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

function saturate(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function smooth(n: number): number {
  const t = saturate(n);
  return t * t * (3 - 2 * t);
}

function outQuart(n: number): number {
  const t = 1 - saturate(n);
  return 1 - t * t * t * t;
}

function writeSegment(mesh: THREE.InstancedMesh, index: number, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  SEG_DIR.subVectors(b, a);
  const length = SEG_DIR.length();
  if (length < 1e-6 || radius <= 1e-6) {
    mesh.setMatrixAt(index, ZERO_M);
    return;
  }
  SEG_DIR.multiplyScalar(1 / length);
  SEG_MID.copy(a).add(b).multiplyScalar(0.5);
  SEG_Q.setFromUnitVectors(UP, SEG_DIR);
  SEG_SCALE.set(radius, length, radius);
  SEG_M.compose(SEG_MID, SEG_Q, SEG_SCALE);
  mesh.setMatrixAt(index, SEG_M);
}

function glowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.24, 'rgba(255,255,255,.82)');
  gradient.addColorStop(0.58, 'rgba(255,255,255,.22)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function dynamicInstances(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.userData.isHighlight = true;
  for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, ZERO_M);
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

interface PoolSlot {
  readonly object: THREE.Object3D;
  alive: boolean;
  tick(dt: number, elapsed: number): void;
  park(): void;
}

function take<T extends PoolSlot>(pool: readonly T[]): T {
  for (const slot of pool) if (!slot.alive) return slot;
  return pool[0];
}

/** A bark-and-sap branch projected from a real hand socket. */
class SapLash implements PoolSlot {
  static readonly SEGMENTS = 30;
  static readonly TWIGS = 10;
  readonly object = new THREE.Group();
  readonly target = new THREE.Vector3();
  alive = false;
  private readonly outer: THREE.InstancedMesh;
  private readonly twigs: THREE.InstancedMesh;
  private readonly core: THREE.InstancedMesh;
  private readonly outerMaterial: THREE.MeshStandardMaterial;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly points = Array.from({ length: SapLash.SEGMENTS + 1 }, () => new THREE.Vector3());
  private readonly origin = new THREE.Vector3();
  private readonly heading = new THREE.Vector3(1, 0, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private from: THREE.Object3D;
  private reach = 1;
  private age = 0;
  private outTime = 0.14;
  private holdTime = 0.16;
  private fadeTime = 0.46;

  private syncEndpoints(): void {
    this.origin.setFromMatrixPosition(this.from.matrixWorld);
    this.target.copy(this.origin).addScaledVector(this.heading, this.reach);
    this.target.y = this.origin.y - this.reach * 0.018;
  }

  copyTarget(out: THREE.Vector3): void {
    this.syncEndpoints();
    out.copy(this.target);
  }

  constructor(from: THREE.Object3D, cylinder: THREE.BufferGeometry) {
    this.from = from;
    this.outerMaterial = new THREE.MeshStandardMaterial({
      color: BARK_LIT,
      roughness: 0.82,
      metalness: 0,
      emissive: DEEP,
      emissiveIntensity: 0.28,
      transparent: true,
      opacity: 1,
      depthWrite: true,
    });
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.eyeIris),
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.outer = dynamicInstances(cylinder, this.outerMaterial, SapLash.SEGMENTS, 'vfx:signature-lash-bark');
    this.twigs = dynamicInstances(cylinder, this.outerMaterial, SapLash.TWIGS, 'vfx:signature-lash-twigs');
    this.core = dynamicInstances(cylinder, this.coreMaterial, SapLash.SEGMENTS, 'vfx:signature-lash-sap');
    this.core.renderOrder = 6;
    this.object.name = 'vfx:signature-lash';
    this.object.add(this.outer, this.twigs, this.core);
    this.object.visible = false;
  }

  restart(from: THREE.Object3D, direction: THREE.Vector3, reach: number, outTime: number): void {
    this.from = from;
    this.reach = reach;
    this.outTime = outTime;
    this.heading.copy(direction).setY(0);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.side.set(-this.heading.z, 0, this.heading.x);
    this.syncEndpoints();
    // Keep the target almost level with the release hand. Depth already changes its apparent
    // screen height; forcing a second world-space height made the lash stand upright like a pole.
    this.age = 0;
    this.alive = true;
    this.object.visible = true;
    this.outerMaterial.opacity = 1;
    this.coreMaterial.opacity = 0.68;
  }

  park(): void {
    this.alive = false;
    this.object.visible = false;
  }

  tick(dt: number, _elapsed: number): void {
    if (!this.alive) return;
    this.age += dt;
    const life = this.outTime + this.holdTime + this.fadeTime;
    if (this.age >= life) {
      this.park();
      return;
    }

    this.syncEndpoints();
    const extension = this.age < this.outTime ? outQuart(this.age / this.outTime) : 1;
    const fade = this.age <= this.outTime + this.holdTime
      ? 0
      : smooth((this.age - this.outTime - this.holdTime) / this.fadeTime);
    const tail = fade * 0.92;
    const wave = (1 - extension) * 0.075 + Math.max(0, 1 - this.age / (this.outTime + 0.06)) * 0.035;

    for (let i = 0; i <= SapLash.SEGMENTS; i += 1) {
      const s = i / SapLash.SEGMENTS;
      const p = this.points[i];
      p.lerpVectors(this.origin, this.target, s);
      const bow = Math.sin(s * Math.PI);
      p.addScaledVector(this.side, bow * this.reach * (0.055 + Math.sin(s * 10 - this.age * 24) * wave));
      p.y += bow * this.reach * (0.072 + Math.sin(s * 7 - this.age * 20) * wave * 0.28);
    }

    for (let i = 0; i < SapLash.SEGMENTS; i += 1) {
      const s = (i + 0.5) / SapLash.SEGMENTS;
      const visible = s <= extension + 0.035 && s >= tail;
      const taper = 1 - s * 0.68;
      const leading = saturate((extension - s) * SapLash.SEGMENTS * 0.65);
      const radius = visible ? this.reach * 0.027 * taper * Math.max(0.22, leading) : 0;
      writeSegment(this.outer, i, this.points[i], this.points[i + 1], radius);
      writeSegment(this.core, i, this.points[i], this.points[i + 1], radius * 0.23);
    }
    // Sparse side growth breaks the silhouette into a living branch without covering its sap
    // spine. Each twig inherits the same reveal/tail window as the section it grows from.
    for (let i = 0; i < SapLash.TWIGS; i += 1) {
      const pointIndex = 3 + i * 2;
      const s = pointIndex / SapLash.SEGMENTS;
      const visible = s <= extension && s >= tail;
      SEG_A.copy(this.points[pointIndex]);
      SEG_B.copy(SEG_A)
        .addScaledVector(this.side, this.reach * (i % 2 ? -0.045 : 0.045) * (0.8 + s))
        .addScaledVector(UP, this.reach * (0.030 + (i % 3) * 0.008));
      writeSegment(this.twigs, i, SEG_A, SEG_B, visible ? this.reach * 0.009 * (1 - s * 0.55) : 0);
    }
    this.outer.instanceMatrix.needsUpdate = true;
    this.twigs.instanceMatrix.needsUpdate = true;
    this.core.instanceMatrix.needsUpdate = true;
    this.outerMaterial.opacity = 1 - fade;
    this.coreMaterial.opacity = (1 - fade) * (0.52 + Math.sin(this.age * 29) * 0.08);
  }
}

type ImpactMode = 'lash' | 'ground' | 'taken';

/** The instant a moving line stops: directional splinters first, colour second. */
class ArrestCrown implements PoolSlot {
  static readonly SPLINTERS = 26;
  readonly object = new THREE.Group();
  alive = false;
  private readonly splinters: THREE.InstancedMesh;
  private readonly sapSplinters: THREE.InstancedMesh;
  private readonly rings: THREE.Mesh[] = [];
  private readonly core: THREE.Mesh;
  private readonly barkMaterial: THREE.MeshStandardMaterial;
  private readonly sapMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly heading = new THREE.Vector3(1, 0, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private readonly velocity = Array.from({ length: ArrestCrown.SPLINTERS }, () => new THREE.Vector3());
  private age = 0;
  private power = 1;
  private mode: ImpactMode = 'lash';
  private readonly scale: number;

  constructor(scale: number, shard: THREE.BufferGeometry, torus: THREE.BufferGeometry) {
    this.scale = scale;
    this.barkMaterial = new THREE.MeshStandardMaterial({
      color: BARK_LIT,
      emissive: DEEP,
      emissiveIntensity: 0.24,
      roughness: 0.78,
      transparent: true,
    });
    this.sapMaterial = new THREE.MeshBasicMaterial({
      color: SAP,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.splinters = dynamicInstances(shard, this.barkMaterial, ArrestCrown.SPLINTERS, 'vfx:impact-splinters');
    this.sapSplinters = dynamicInstances(shard, this.sapMaterial, ArrestCrown.SPLINTERS, 'vfx:impact-sap-splinters');
    this.sapSplinters.renderOrder = 7;
    this.object.add(this.splinters, this.sapSplinters);

    for (let i = 0; i < 3; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: i === 1 ? SAP : LIFE,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(torus, material);
      ring.name = `vfx:impact-arrest-ring:${i}`;
      ring.userData.isHighlight = true;
      ring.renderOrder = 8;
      this.rings.push(ring);
      this.ringMaterials.push(material);
      this.object.add(ring);
    }
    this.coreMaterial = new THREE.MeshBasicMaterial({
      // The one warm accent is resin exposed by the arrest, not a generic white detonation.
      color: SEED,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(scale * 0.018, 1), this.coreMaterial);
    this.core.name = 'vfx:impact-sap-core';
    this.core.userData.isHighlight = true;
    this.core.renderOrder = 9;
    this.object.add(this.core);
    this.object.name = 'vfx:signature-impact';
    this.object.visible = false;
  }

  restart(at: THREE.Vector3, direction: THREE.Vector3, power: number, mode: ImpactMode): void {
    this.object.position.copy(at);
    this.heading.copy(direction);
    if (mode === 'ground') this.heading.set(0, 1, 0);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.side.set(-this.heading.z, 0, this.heading.x);
    if (this.side.lengthSq() < 1e-8) this.side.set(1, 0, 0);
    this.side.normalize();
    this.power = power;
    this.mode = mode;
    this.age = 0;
    this.alive = true;
    this.object.visible = true;
    this.barkMaterial.opacity = 1;
    this.sapMaterial.opacity = 1;

    for (let i = 0; i < ArrestCrown.SPLINTERS; i += 1) {
      const u = (i + 0.5) / ArrestCrown.SPLINTERS;
      const angle = u * Math.PI * 2 + (i % 3) * 0.31;
      if (mode === 'ground') {
        this.velocity[i].set(Math.cos(angle), 0.35 + (i % 5) * 0.13, Math.sin(angle)).normalize();
      } else {
        this.velocity[i].copy(this.heading).multiplyScalar(0.36 + (i % 4) * 0.12)
          .addScaledVector(this.side, Math.sin(angle) * 0.82)
          .addScaledVector(UP, Math.cos(angle) * 0.72);
        if (mode === 'taken') this.velocity[i].multiplyScalar(-1);
        this.velocity[i].normalize();
      }
    }

    const normal = mode === 'ground' ? UP : this.heading;
    SEG_Q.setFromUnitVectors(Z_AXIS, normal);
    for (const ring of this.rings) {
      ring.quaternion.copy(SEG_Q);
      ring.scale.setScalar(0.001);
    }
    this.core.scale.setScalar(0.001);
  }

  park(): void {
    this.alive = false;
    this.object.visible = false;
  }

  tick(dt: number, _elapsed: number): void {
    if (!this.alive) return;
    this.age += dt;
    const duration = this.mode === 'ground' ? 0.86 : 0.64;
    const t = this.age / duration;
    if (t >= 1) {
      this.park();
      return;
    }
    const fade = 1 - smooth((t - 0.48) / 0.52);
    const inward = this.mode === 'taken';

    for (let i = 0; i < ArrestCrown.SPLINTERS; i += 1) {
      const stagger = saturate(t * 2.7 - (i % 5) * 0.045);
      // A taken blow is not an outgoing hit reversed. Its RING compresses inward, while the bark
      // fragments still leave the body in the direction the force tears them loose. The old code
      // pulled both toward the chest and visually swallowed its own debris.
      const travel = this.scale * this.power * (0.12 + (i % 7) * 0.018) * outQuart(stagger);
      SEG_A.copy(this.velocity[i]).multiplyScalar(travel);
      SEG_B.copy(SEG_A).addScaledVector(this.velocity[i], this.scale * this.power * (0.055 + (i % 4) * 0.012));
      const radius = this.scale * this.power * 0.010 * fade;
      writeSegment(this.splinters, i, SEG_A, SEG_B, radius);
      writeSegment(this.sapSplinters, i, SEG_A, SEG_B, radius * 0.34);
    }
    this.splinters.instanceMatrix.needsUpdate = true;
    this.sapSplinters.instanceMatrix.needsUpdate = true;
    this.barkMaterial.opacity = fade;
    this.sapMaterial.opacity = fade * 0.9;

    for (let i = 0; i < this.rings.length; i += 1) {
      const local = saturate(t * 1.55 - i * 0.16);
      const ringTravel = inward ? 1 - outQuart(local) : outQuart(local);
      // An incoming blow needs a readable compression envelope before the fragments leave the
      // body. The previous taken ring began at only 0.07 figure heights and disappeared into the
      // chest silhouette; start broad, then collapse it to the wound while outgoing arrests keep
      // their compact expansion.
      const base = inward ? 0.050 : 0.026;
      const reach = inward ? 0.190 + i * 0.045 : 0.075 + i * 0.025;
      const size = this.scale * this.power * (base + ringTravel * reach);
      this.rings[i].scale.setScalar(size);
      // One incomplete compression arc is enough to define the stop. Stacking three recreated
      // the portal silhouette this layer replaced.
      const gain = this.mode === 'ground' ? 0 : (i === 0 ? (inward ? 0.42 : 0.28) : 0);
      this.ringMaterials[i].opacity = (1 - smooth(local)) * gain;
    }
    const core = Math.sin(Math.min(1, t * 2.2) * Math.PI);
    this.core.scale.setScalar(0.22 + core * this.power * 0.92);
    this.coreMaterial.opacity = core * 0.48;
  }
}

/** A wedge of roots whose crest visibly travels away from a two-hand ground contact. */
class RootQuake implements PoolSlot {
  static readonly ROOTS = 42;
  static readonly CRACKS = 30;
  readonly object = new THREE.Group();
  alive = false;
  private readonly bark: THREE.InstancedMesh;
  private readonly sap: THREE.InstancedMesh;
  private readonly barkMaterial: THREE.MeshStandardMaterial;
  private readonly sapMaterial: THREE.MeshBasicMaterial;
  private readonly cracks: THREE.LineSegments;
  private readonly crackMaterial: THREE.LineBasicMaterial;
  private readonly rootDistance = new Float32Array(RootQuake.ROOTS);
  private readonly rootLateral = new Float32Array(RootQuake.ROOTS);
  private readonly rootHeight = new Float32Array(RootQuake.ROOTS);
  private readonly heading = new THREE.Vector3(1, 0, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private age = 0;
  private power = 1;
  private readonly scale: number;

  constructor(scale: number, cylinder: THREE.BufferGeometry) {
    this.scale = scale;
    this.barkMaterial = new THREE.MeshStandardMaterial({
      color: BARK_LIT,
      emissive: DEEP,
      emissiveIntensity: 0.13,
      roughness: 0.9,
      transparent: true,
    });
    this.sapMaterial = new THREE.MeshBasicMaterial({
      color: DEEP,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.bark = dynamicInstances(cylinder, this.barkMaterial, RootQuake.ROOTS, 'vfx:root-wave-bark');
    this.sap = dynamicInstances(cylinder, this.sapMaterial, RootQuake.ROOTS, 'vfx:root-wave-sap');
    this.sap.renderOrder = 4;
    this.object.add(this.bark, this.sap);

    for (let i = 0; i < RootQuake.ROOTS; i += 1) {
      const row = Math.floor(i / 7);
      const lane = (i % 7) - 3;
      const rowK = row / 5;
      // Keep the far crest inside the public camera. At the old 1.1-height reach the last row was
      // cut in half by the viewport, which made a deliberate root wave look like broken geometry.
      this.rootDistance[i] = 0.07 + rowK * 0.40 + ((i * 17) % 11) * 0.004;
      this.rootLateral[i] = lane * (0.035 + rowK * 0.034) + Math.sin(i * 2.31) * 0.018;
      this.rootHeight[i] = 0.06 + rowK * 0.10 + ((i * 7) % 5) * 0.013;
    }

    const crackGeometry = new THREE.BufferGeometry();
    crackGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RootQuake.CRACKS * 2 * 3), 3));
    crackGeometry.setDrawRange(0, 0);
    this.crackMaterial = new THREE.LineBasicMaterial({
      color: LIFE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.cracks = new THREE.LineSegments(crackGeometry, this.crackMaterial);
    this.cracks.name = 'vfx:root-wave-fracture';
    this.cracks.renderOrder = 5;
    this.cracks.frustumCulled = false;
    this.cracks.userData.isHighlight = true;
    this.object.add(this.cracks);
    this.object.name = 'vfx:signature-root-wave';
    this.object.visible = false;
  }

  restart(at: THREE.Vector3, direction: THREE.Vector3, power: number): void {
    this.object.position.set(at.x, 0.018, at.z);
    this.heading.copy(direction).setY(0);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.side.set(-this.heading.z, 0, this.heading.x);
    this.power = power;
    this.age = 0;
    this.alive = true;
    this.object.visible = true;
    this.barkMaterial.opacity = 1;
    this.sapMaterial.opacity = 0.9;
    this.crackMaterial.opacity = 0.62;

    const attr = this.cracks.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < RootQuake.CRACKS; i += 1) {
      const u0 = i / RootQuake.CRACKS;
      const u1 = (i + 1) / RootQuake.CRACKS;
      const branch = ((i % 5) - 2) * (0.025 + u0 * 0.16) + Math.sin(i * 1.7) * 0.028;
      const branchNext = branch + Math.sin(i * 3.1) * 0.035;
      const d0 = this.scale * this.power * (0.06 + u0 * 0.52);
      const d1 = this.scale * this.power * (0.06 + u1 * 0.52);
      attr.setXYZ(i * 2,
        this.heading.x * d0 + this.side.x * branch * this.scale,
        0,
        this.heading.z * d0 + this.side.z * branch * this.scale);
      attr.setXYZ(i * 2 + 1,
        this.heading.x * d1 + this.side.x * branchNext * this.scale,
        0,
        this.heading.z * d1 + this.side.z * branchNext * this.scale);
    }
    attr.needsUpdate = true;
    this.cracks.geometry.setDrawRange(0, 0);
  }

  park(): void {
    this.alive = false;
    this.object.visible = false;
  }

  tick(dt: number, _elapsed: number): void {
    if (!this.alive) return;
    this.age += dt;
    const duration = 1.55;
    const t = this.age / duration;
    if (t >= 1) {
      this.park();
      return;
    }
    const fade = 1 - smooth((t - 0.66) / 0.34);
    const front = outQuart(t / 0.48);
    this.cracks.geometry.setDrawRange(0, Math.floor(RootQuake.CRACKS * 2 * front));
    this.crackMaterial.opacity = fade * 0.58;

    for (let i = 0; i < RootQuake.ROOTS; i += 1) {
      const distance = this.rootDistance[i];
      const arrival = distance * 0.48;
      const rise = outQuart((t - arrival) / 0.17);
      const settle = smooth((t - arrival - 0.22) / 0.44);
      const height = this.scale * this.power * this.rootHeight[i] * rise * (1 - settle * 0.72);
      const lateral = this.scale * this.power * this.rootLateral[i];
      const forward = this.scale * this.power * distance;
      SEG_A.set(this.heading.x * forward + this.side.x * lateral, -0.018,
        this.heading.z * forward + this.side.z * lateral);
      SEG_B.copy(SEG_A)
        .addScaledVector(this.heading, height * (0.26 + (i % 3) * 0.06))
        .addScaledVector(this.side, Math.sin(i * 2.7) * height * 0.18);
      SEG_B.y = height;
      const radius = this.scale * this.power * (0.021 + (i % 4) * 0.0028) * rise * fade;
      writeSegment(this.bark, i, SEG_A, SEG_B, radius);
      SEG_A.lerp(SEG_B, 0.10);
      SEG_B.lerp(SEG_A, 0.12);
      writeSegment(this.sap, i, SEG_A, SEG_B, radius * 0.27);
    }
    this.bark.instanceMatrix.needsUpdate = true;
    this.sap.instanceMatrix.needsUpdate = true;
    this.barkMaterial.opacity = fade;
    this.sapMaterial.opacity = fade * (0.58 + Math.sin(this.age * 25) * 0.16);
  }
}

/**
 * Interlocking bark ribs that close IN around the torso before a hit.
 *
 * This is deliberately not a bubble or a recoloured impact ring. The readable motion is a set of
 * rigid wooden laminations sliding toward each other and overlapping in front of crossed arms;
 * the sap seams only make that motion legible in the dark palette.
 */
class BarkWard {
  static readonly RIBS = 10;
  readonly object = new THREE.Group();
  strength = 0;
  private readonly bark: THREE.InstancedMesh;
  private readonly seams: THREE.InstancedMesh;
  private readonly barkMaterial: THREE.MeshStandardMaterial;
  private readonly seamMaterial: THREE.MeshBasicMaterial;
  private readonly chest: THREE.Object3D;
  private readonly root: THREE.Object3D;
  private readonly centre = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(1, 0, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private pulseAge = 99;
  private readonly scale: number;

  constructor(rig: SignatureRig, scale: number, cylinder: THREE.BufferGeometry) {
    this.scale = scale;
    this.chest = rig.sockets['chest-core'];
    this.root = rig.group;
    this.barkMaterial = new THREE.MeshStandardMaterial({
      color: BARK_LIT,
      emissive: BARK_LIT,
      emissiveIntensity: 0.34,
      roughness: 0.91,
      transparent: true,
      opacity: 0,
    });
    this.seamMaterial = new THREE.MeshBasicMaterial({
      color: LIFE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.bark = dynamicInstances(cylinder, this.barkMaterial, BarkWard.RIBS, 'vfx:ward-bark-ribs');
    this.seams = dynamicInstances(cylinder, this.seamMaterial, BarkWard.RIBS, 'vfx:ward-sap-seams');
    this.seams.renderOrder = 7;
    this.object.name = 'vfx:heartwood-ward';
    this.object.add(this.bark, this.seams);
    this.object.visible = false;
  }

  hit(): void {
    this.pulseAge = 0;
  }

  tick(dt: number, _elapsed: number): void {
    this.pulseAge += dt;
    const level = smooth(this.strength);
    this.object.visible = level > 0.005;
    if (!this.object.visible) return;
    this.centre.setFromMatrixPosition(this.chest.matrixWorld);
    this.forward.set(1, 0, 0).transformDirection(this.root.matrixWorld).setY(0);
    if (this.forward.lengthSq() < 1e-8) this.forward.set(1, 0, 0);
    this.forward.normalize();
    this.side.set(-this.forward.z, 0, this.forward.x);
    const pulse = this.pulseAge < 0.34
      ? Math.sin((this.pulseAge / 0.34) * Math.PI) * (1 - this.pulseAge / 0.34)
      : 0;

    for (let i = 0; i < BarkWard.RIBS; i += 1) {
      const u = (i + 0.5) / BarkWard.RIBS;
      const row = u * 2 - 1;
      // Centre slats arrive first, the outer ones a few frames later. Each slat crosses the full
      // torso and alternates its diagonal, so the finished object is an interlocked bark lattice,
      // not the one-ended hanging roots produced by the earlier fan.
      const local = smooth(level * 1.42 - Math.abs(row) * 0.30);
      const width = this.scale * (0.18 + (1 - local) * 0.16);
      const front = this.scale * (0.13 - pulse * 0.035);
      const tilt = (i % 2 ? 1 : -1) * this.scale * 0.060;
      const y = row * this.scale * 0.070;
      SEG_A.copy(this.centre).addScaledVector(this.forward, front)
        .addScaledVector(this.side, -width);
      SEG_B.copy(this.centre).addScaledVector(this.forward, front)
        .addScaledVector(this.side, width);
      SEG_A.y += y - tilt;
      SEG_B.y += y + tilt;
      const radius = this.scale * (0.012 + (1 - Math.abs(row)) * 0.006) * local;
      writeSegment(this.bark, i, SEG_A, SEG_B, radius);
      SEG_A.lerp(SEG_B, 0.30);
      SEG_B.lerp(SEG_A, 0.18);
      writeSegment(this.seams, i, SEG_A, SEG_B, radius * 0.22);
    }
    this.bark.instanceMatrix.needsUpdate = true;
    this.seams.instanceMatrix.needsUpdate = true;
    this.barkMaterial.opacity = level * (0.92 - pulse * 0.12);
    this.seamMaterial.opacity = level * (0.34 + pulse * 0.58);
  }
}

/** One warm seed following a readable ballistic arc, then becoming a small rooted sapling. */
class FirstbornSeed implements PoolSlot {
  static readonly TRAIL = 18;
  static readonly SPROUT = 12;
  readonly object = new THREE.Group();
  alive = false;
  private readonly seed: THREE.Mesh;
  private readonly seedMaterial: THREE.MeshStandardMaterial;
  private readonly core: THREE.Mesh;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly trail: THREE.InstancedMesh;
  private readonly trailMaterial: THREE.MeshBasicMaterial;
  private readonly sprout: THREE.InstancedMesh;
  private readonly sproutCore: THREE.InstancedMesh;
  private readonly sproutMaterial: THREE.MeshStandardMaterial;
  private readonly sproutCoreMaterial: THREE.MeshBasicMaterial;
  private readonly origin = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly heading = new THREE.Vector3(1, 0, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private readonly point = new THREE.Vector3();
  private age = 0;
  private flight = 0.58;
  private readonly scale: number;

  constructor(scale: number, shard: THREE.BufferGeometry, cylinder: THREE.BufferGeometry) {
    this.scale = scale;
    this.seedMaterial = new THREE.MeshStandardMaterial({
      // A detached seed should read as a warm resin kernel, not a flesh-coloured hole in the
      // character. The pale palette stays in the trail/core while the solid shell remains dark.
      color: SEED_SHELL,
      emissive: new THREE.Color(PALETTE.leatherMid),
      emissiveIntensity: 0.82,
      roughness: 0.72,
      transparent: true,
    });
    this.seed = new THREE.Mesh(new THREE.OctahedronGeometry(scale * 0.020, 1), this.seedMaterial);
    this.seed.scale.set(0.78, 1.42, 0.78);
    this.seed.castShadow = true;
    this.seed.name = 'vfx:firstborn-seed';
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: LIFE, transparent: true, opacity: 0.64,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(scale * 0.017, 1), this.coreMaterial);
    this.core.renderOrder = 8;
    this.trailMaterial = new THREE.MeshBasicMaterial({
      color: LIFE, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.trail = dynamicInstances(shard, this.trailMaterial, FirstbornSeed.TRAIL, 'vfx:firstborn-seed-trail');
    this.trail.renderOrder = 7;
    this.sproutMaterial = new THREE.MeshStandardMaterial({
      color: BARK_LIT, emissive: DEEP, emissiveIntensity: 0.22,
      roughness: 0.92, transparent: true, opacity: 0,
    });
    this.sproutCoreMaterial = new THREE.MeshBasicMaterial({
      color: LIFE, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sprout = dynamicInstances(cylinder, this.sproutMaterial, FirstbornSeed.SPROUT, 'vfx:firstborn-sapling-bark');
    this.sproutCore = dynamicInstances(cylinder, this.sproutCoreMaterial, FirstbornSeed.SPROUT, 'vfx:firstborn-sapling-sap');
    this.sproutCore.renderOrder = 6;
    this.object.name = 'vfx:firstborn-seed-cast';
    this.object.add(this.seed, this.core, this.trail, this.sprout, this.sproutCore);
    this.object.visible = false;
  }

  restart(from: THREE.Object3D, direction: THREE.Vector3, reach: number, flight: number): void {
    this.origin.setFromMatrixPosition(from.matrixWorld);
    this.heading.copy(direction).setY(0);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.side.set(-this.heading.z, 0, this.heading.x);
    // Clear the wrist and the trunk on the release frame. Starting exactly at the socket left the
    // opaque kernel embedded in the underhand pose for several frames before the arc separated.
    this.origin.addScaledVector(this.heading, this.scale * 0.060)
      .addScaledVector(this.side, this.scale * 0.018);
    this.target.copy(this.origin).addScaledVector(this.heading, reach).addScaledVector(this.side, reach * 0.22);
    this.target.y = 0.025;
    this.flight = flight;
    this.age = 0;
    this.alive = true;
    this.object.visible = true;
    this.seed.visible = true;
    this.core.visible = true;
    this.seedMaterial.opacity = 1;
    this.coreMaterial.opacity = 0.64;
    this.sproutMaterial.opacity = 1;
    this.sproutCoreMaterial.opacity = 0.7;
  }

  park(): void {
    this.alive = false;
    this.object.visible = false;
  }

  private arc(u: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(this.origin, this.target, u);
    out.y += Math.sin(u * Math.PI) * this.scale * 0.28;
    return out;
  }

  tick(dt: number, _elapsed: number): void {
    if (!this.alive) return;
    this.age += dt;
    const u = saturate(this.age / this.flight);
    const after = Math.max(0, this.age - this.flight);
    const fade = 1 - smooth((after - 0.92) / 0.48);
    if (this.age > this.flight + 1.40) {
      this.park();
      return;
    }

    if (u < 1) {
      this.arc(u, this.point);
      this.seed.position.copy(this.point);
      this.core.position.copy(this.point);
      this.seed.rotation.x += dt * 8.4;
      this.seed.rotation.z += dt * 5.7;
      const throb = 1 + Math.sin(this.age * 21) * 0.14;
      this.core.scale.setScalar(throb);
      for (let i = 0; i < FirstbornSeed.TRAIL; i += 1) {
        const p = u - (i + 1) * 0.028;
        if (p <= 0) {
          this.trail.setMatrixAt(i, ZERO_M);
          continue;
        }
        this.arc(p, SEG_MID);
        SEG_Q.setFromAxisAngle(UP, i * 1.7 + this.age * 8);
        // `shard` is a unit cone. Scale it in figure heights; the previous dimensionless 0.62
        // produced metre-wide wedges that covered the character even though the flight was right.
        const s = this.scale * 0.014 * (1 - i / FirstbornSeed.TRAIL);
        SEG_SCALE.set(s * 0.48, s * 1.12, s * 0.48);
        SEG_M.compose(SEG_MID, SEG_Q, SEG_SCALE);
        this.trail.setMatrixAt(i, SEG_M);
      }
      this.trailMaterial.opacity = 0.62;
    } else {
      this.seed.visible = false;
      this.core.visible = false;
      for (let i = 0; i < FirstbornSeed.TRAIL; i += 1) this.trail.setMatrixAt(i, ZERO_M);
      this.trailMaterial.opacity = 0;
    }
    this.trail.instanceMatrix.needsUpdate = true;

    const grow = outQuart(after / 0.46);
    for (let i = 0; i < FirstbornSeed.SPROUT; i += 1) {
      const ring = Math.floor(i / 3);
      const lane = i % 3;
      const reveal = smooth(grow * 1.45 - ring * 0.13);
      if (reveal <= 0.002) {
        this.sprout.setMatrixAt(i, ZERO_M);
        this.sproutCore.setMatrixAt(i, ZERO_M);
        continue;
      }
      const angle = lane * Math.PI * 2 / 3 + ring * 0.72;
      const baseHeight = ring * this.scale * 0.043;
      const radial = ring === 0 ? 0 : this.scale * ring * 0.015;
      SEG_A.copy(this.target).addScaledVector(this.side, Math.sin(angle) * radial)
        .addScaledVector(this.heading, Math.cos(angle) * radial);
      SEG_A.y += baseHeight;
      SEG_B.copy(SEG_A)
        .addScaledVector(this.side, Math.sin(angle) * this.scale * (0.025 + ring * 0.012))
        .addScaledVector(this.heading, Math.cos(angle) * this.scale * (0.025 + ring * 0.012));
      SEG_B.y += this.scale * (0.075 - ring * 0.006) * reveal;
      const radius = this.scale * (0.010 - ring * 0.0014) * reveal * fade;
      writeSegment(this.sprout, i, SEG_A, SEG_B, radius);
      SEG_A.lerp(SEG_B, 0.14);
      writeSegment(this.sproutCore, i, SEG_A, SEG_B, radius * 0.24);
    }
    this.sprout.instanceMatrix.needsUpdate = true;
    this.sproutCore.instanceMatrix.needsUpdate = true;
    this.sproutMaterial.opacity = fade;
    this.sproutCoreMaterial.opacity = fade * (0.48 + Math.sin(after * 12) * 0.12);
  }
}

/** Quiet, character-following sap circulation — no attack ring and no lawn. */
class RootBreath {
  readonly object = new THREE.Group();
  strength = 0;
  private readonly roots: THREE.LineSegments;
  private readonly rootMaterial: THREE.LineBasicMaterial;
  private readonly motes: THREE.Points;
  private readonly moteMaterial: THREE.PointsMaterial;
  private readonly phases = new Float32Array(48);
  private readonly radii = new Float32Array(48);
  private readonly angles = new Float32Array(48);
  private readonly foot = new THREE.Vector3();
  private readonly chest = new THREE.Vector3();
  private readonly footL: THREE.Object3D;
  private readonly footR: THREE.Object3D;
  private readonly chestSocket: THREE.Object3D;
  private readonly scale: number;

  constructor(rig: SignatureRig, scale: number, glow: THREE.Texture) {
    this.scale = scale;
    this.footL = rig.sockets['foot-l'];
    this.footR = rig.sockets['foot-r'];
    this.chestSocket = rig.sockets['chest-core'];

    const rootPositions = new Float32Array(18 * 2 * 3);
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2 + Math.sin(i * 4.1) * 0.16;
      const radius = scale * (0.22 + (i % 5) * 0.035);
      rootPositions[i * 6] = Math.cos(angle) * scale * 0.035;
      rootPositions[i * 6 + 1] = 0;
      rootPositions[i * 6 + 2] = Math.sin(angle) * scale * 0.035;
      rootPositions[i * 6 + 3] = Math.cos(angle) * radius;
      rootPositions[i * 6 + 4] = Math.sin(i * 2.2) * scale * 0.006;
      rootPositions[i * 6 + 5] = Math.sin(angle) * radius;
    }
    const rootGeometry = new THREE.BufferGeometry();
    rootGeometry.setAttribute('position', new THREE.BufferAttribute(rootPositions, 3));
    this.rootMaterial = new THREE.LineBasicMaterial({
      color: LIFE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.roots = new THREE.LineSegments(rootGeometry, this.rootMaterial);
    this.roots.name = 'vfx:root-breath-veins';
    this.roots.userData.isHighlight = true;
    this.roots.renderOrder = 2;
    this.object.add(this.roots);

    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3));
    this.moteMaterial = new THREE.PointsMaterial({
      map: glow,
      color: SAP,
      size: scale * 0.026,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.motes = new THREE.Points(moteGeometry, this.moteMaterial);
    this.motes.name = 'vfx:root-breath-sap';
    this.motes.userData.isHighlight = true;
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 3;
    this.object.add(this.motes);
    for (let i = 0; i < 48; i += 1) {
      this.phases[i] = ((i * 29) % 47) / 47;
      this.radii[i] = 0.04 + ((i * 13) % 11) / 11 * 0.24;
      this.angles[i] = ((i * 17) % 48) / 48 * Math.PI * 2;
    }
    this.object.name = 'vfx:signature-root-breath';
    this.object.visible = false;
  }

  tick(_dt: number, elapsed: number): void {
    const visible = this.strength > 0.005;
    this.object.visible = visible;
    if (!visible) return;
    this.foot.setFromMatrixPosition(this.footL.matrixWorld)
      .add(SEG_A.setFromMatrixPosition(this.footR.matrixWorld)).multiplyScalar(0.5);
    this.chest.setFromMatrixPosition(this.chestSocket.matrixWorld);
    this.object.position.set(this.foot.x, 0.022, this.foot.z);
    const height = Math.max(this.scale * 0.35, this.chest.y - this.foot.y);
    const positions = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 48; i += 1) {
      const u = (this.phases[i] + elapsed * (0.065 + (i % 4) * 0.006)) % 1;
      const gather = (1 - u) ** 0.72;
      const radius = this.radii[i] * this.scale * gather;
      const angle = this.angles[i] + elapsed * (0.42 + (i % 3) * 0.08);
      positions.setXYZ(i,
        Math.cos(angle) * radius,
        u * height,
        Math.sin(angle) * radius);
    }
    positions.needsUpdate = true;
    const breathe = 0.76 + Math.sin(elapsed * 1.35) * 0.14;
    this.rootMaterial.opacity = this.strength * breathe * 0.22;
    this.moteMaterial.opacity = this.strength * breathe * 0.62;
    this.roots.scale.setScalar(0.92 + this.strength * 0.10 + Math.sin(elapsed * 1.35) * 0.025);
  }
}

/** A held canopy of rotating sap rings and warm seeds for the ultimate. */
class CanopyCharge {
  readonly object = new THREE.Group();
  strength = 0;
  private pulse = 0;
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly seeds: THREE.InstancedMesh;
  private readonly seedMaterial: THREE.MeshBasicMaterial;
  private readonly crown: THREE.Object3D;
  private readonly scale: number;

  constructor(crown: THREE.Object3D, scale: number, torus: THREE.BufferGeometry) {
    this.crown = crown;
    this.scale = scale;
    for (let i = 0; i < 3; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: i === 2 ? SEED : LIFE,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(torus, material);
      ring.name = `vfx:canopy-sap-ring:${i}`;
      ring.userData.isHighlight = true;
      ring.renderOrder = 6;
      ring.rotation.set(i * 0.72, i * 0.91, i * 0.47);
      this.rings.push(ring);
      this.ringMaterials.push(material);
      this.object.add(ring);
    }
    this.seedMaterial = new THREE.MeshBasicMaterial({
      color: SEED,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.seeds = dynamicInstances(new THREE.SphereGeometry(scale * 0.009, 5, 4), this.seedMaterial, 32, 'vfx:canopy-seeds');
    this.seeds.renderOrder = 7;
    this.object.add(this.seeds);
    this.object.name = 'vfx:signature-canopy';
    this.object.visible = false;
  }

  release(): void {
    this.pulse = 1;
  }

  tick(dt: number, elapsed: number): void {
    this.pulse = Math.max(0, this.pulse - dt * 0.72);
    const level = Math.max(this.strength, this.pulse);
    this.object.visible = level > 0.005;
    if (!this.object.visible) return;
    this.object.position.setFromMatrixPosition(this.crown.matrixWorld);
    // The crown belongs above the antlers. Centring it on the socket put opaque seeds directly
    // across the face, hiding the character during its most important silhouette.
    this.object.position.y += this.scale * 0.10;
    for (let i = 0; i < this.rings.length; i += 1) {
      const radius = this.scale * (0.050 + i * 0.027) * (0.78 + level * 0.42 + this.pulse * 0.20);
      this.rings[i].scale.setScalar(radius);
      this.rings[i].rotation.x += dt * (0.45 + i * 0.17);
      this.rings[i].rotation.y += dt * (i % 2 ? -0.72 : 0.61);
      this.ringMaterials[i].opacity = level * (0.30 - i * 0.04);
    }
    for (let i = 0; i < 32; i += 1) {
      if (i >= 24) {
        this.seeds.setMatrixAt(i, ZERO_M);
        continue;
      }
      const phase = (i / 24) * Math.PI * 2 + elapsed * (0.27 + (i % 4) * 0.045);
      const band = (i % 4) / 3;
      const radius = this.scale * (0.052 + band * 0.095) * (0.72 + level * 0.34);
      SEG_MID.set(
        Math.cos(phase) * radius,
        Math.sin(phase * 1.55 + i) * this.scale * 0.045,
        Math.sin(phase) * radius,
      );
      SEG_Q.setFromAxisAngle(UP, phase + elapsed * 1.8);
      const size = (0.32 + level * 0.58) * (1 + this.pulse * 0.28);
      SEG_SCALE.set(size * 0.62, size * 1.35, size * 0.62);
      SEG_M.compose(SEG_MID, SEG_Q, SEG_SCALE);
      this.seeds.setMatrixAt(i, SEG_M);
    }
    this.seeds.instanceMatrix.needsUpdate = true;
    this.seedMaterial.opacity = level * 0.56;
  }
}

/** Sap fragments travelling along the arm chains into the hands during anticipation. */
class HandGather {
  readonly object: THREE.InstancedMesh;
  left = 0;
  right = 0;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly shoulderL: THREE.Object3D;
  private readonly shoulderR: THREE.Object3D;
  private readonly handL: THREE.Object3D;
  private readonly handR: THREE.Object3D;
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly scale: number;

  constructor(rig: SignatureRig, scale: number) {
    this.scale = scale;
    this.shoulderL = rig.bones.L_Upperarm;
    this.shoulderR = rig.bones.R_Upperarm;
    this.handL = rig.sockets['grip-l'];
    this.handR = rig.sockets['grip-r'];
    this.material = new THREE.MeshBasicMaterial({
      color: LIFE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.object = dynamicInstances(
      new THREE.OctahedronGeometry(scale * 0.010, 0),
      this.material,
      40,
      'vfx:hand-gather',
    );
    this.object.renderOrder = 6;
    this.object.visible = false;
  }

  tick(_dt: number, elapsed: number): void {
    const level = Math.max(this.left, this.right);
    this.object.visible = level > 0.005;
    if (!this.object.visible) return;
    for (let i = 0; i < 40; i += 1) {
      const isRight = i >= 20;
      const strength = isRight ? this.right : this.left;
      const local = i % 20;
      const startObject = isRight ? this.shoulderR : this.shoulderL;
      const endObject = isRight ? this.handR : this.handL;
      this.start.setFromMatrixPosition(startObject.matrixWorld);
      this.end.setFromMatrixPosition(endObject.matrixWorld);
      const u = (local / 20 + elapsed * (0.72 + (local % 4) * 0.055)) % 1;
      this.point.lerpVectors(this.start, this.end, u);
      const radius = this.scale * 0.020 * (1 - u) * strength;
      const angle = local * 2.4 + elapsed * 6.2;
      this.point.x += Math.cos(angle) * radius;
      this.point.z += Math.sin(angle) * radius;
      SEG_Q.setFromAxisAngle(UP, angle);
      const size = strength * (0.32 + u * 0.82);
      SEG_SCALE.set(size * 0.55, size * 1.45, size * 0.55);
      SEG_M.compose(this.point, SEG_Q, SEG_SCALE);
      this.object.setMatrixAt(i, strength > 0.005 ? SEG_M : ZERO_M);
    }
    this.object.instanceMatrix.needsUpdate = true;
    this.material.opacity = level * (0.48 + Math.sin(elapsed * 8) * 0.08);
  }
}

/** Contract used by the skill table; all event times remain outside this rendering layer. */
export class TreantSignatureVfx {
  readonly group = new THREE.Group();
  private readonly lashes: SapLash[] = [];
  private readonly impacts: ArrestCrown[] = [];
  private readonly quakes: RootQuake[] = [];
  private readonly breath: RootBreath;
  private readonly canopy: CanopyCharge;
  private readonly handGather: HandGather;
  private readonly ward: BarkWard;
  private readonly seeds: FirstbornSeed[] = [];
  private readonly lashTarget = new THREE.Vector3();
  private readonly lashHeading = new THREE.Vector3(1, 0, 0);
  private activeLash: SapLash | null = null;

  constructor(rig: SignatureRig, private readonly scale: number) {
    this.group.name = 'monster-tree-signature-vfx';
    this.group.userData.isHighlight = true;
    // A round shared section plus per-segment radius taper keeps the lash continuous. A tapered
    // six-sided section repeated thirty times exposed every join as a saw-tooth silhouette.
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
    const rootShape = new THREE.ConeGeometry(0.78, 1, 6, 2, false);
    const shard = new THREE.ConeGeometry(1, 1, 5, 1, false);
    // Broken arcs, not complete portal rings. The open side points back toward the incoming force.
    const torus = new THREE.TorusGeometry(1, 0.032, 5, 42, Math.PI * 1.46);
    const glow = glowTexture();
    for (let i = 0; i < 2; i += 1) {
      const lash = new SapLash(rig.sockets['grip-l'], cylinder);
      this.lashes.push(lash);
      this.group.add(lash.object);
    }
    for (let i = 0; i < 6; i += 1) {
      const impact = new ArrestCrown(scale, shard, torus);
      this.impacts.push(impact);
      this.group.add(impact.object);
    }
    for (let i = 0; i < 4; i += 1) {
      const quake = new RootQuake(scale, rootShape);
      this.quakes.push(quake);
      this.group.add(quake.object);
    }
    this.breath = new RootBreath(rig, scale, glow);
    this.canopy = new CanopyCharge(rig.sockets.crown, scale, torus);
    this.handGather = new HandGather(rig, scale);
    this.ward = new BarkWard(rig, scale, rootShape);
    for (let i = 0; i < 2; i += 1) {
      const seed = new FirstbornSeed(scale, shard, cylinder);
      this.seeds.push(seed);
      this.group.add(seed.object);
    }
    this.group.add(this.breath.object, this.canopy.object, this.handGather.object, this.ward.object);
    this.group.traverse((object) => { object.userData.isHighlight = true; });
  }

  set passiveStrength(value: number) {
    this.breath.strength = saturate(value);
  }

  set canopyStrength(value: number) {
    this.canopy.strength = saturate(value);
  }

  set wardStrength(value: number) {
    this.ward.strength = saturate(value);
  }

  gather(left: number, right: number): void {
    this.handGather.left = saturate(left);
    this.handGather.right = saturate(right);
  }

  castLash(from: THREE.Object3D, direction: THREE.Vector3, reachInHeights = 0.82, outTime = 0.14): void {
    const lash = take(this.lashes);
    lash.restart(from, direction, reachInHeights * this.scale, outTime);
    this.activeLash = lash;
    this.lashTarget.copy(lash.target);
    this.lashHeading.copy(direction).setY(0);
    if (this.lashHeading.lengthSq() < 1e-8) this.lashHeading.set(1, 0, 0);
    this.lashHeading.normalize();
  }

  arrestLash(rig?: { hitstop(seconds: number, scale?: number): void }, power = 1): THREE.Vector3 {
    rig?.hitstop(0.065, 0.025);
    this.activeLash?.copyTarget(this.lashTarget);
    take(this.impacts).restart(this.lashTarget, this.lashHeading, power, 'lash');
    return this.lashTarget;
  }

  groundContact(
    at: THREE.Vector3,
    direction: THREE.Vector3,
    rig?: { hitstop(seconds: number, scale?: number): void },
    power = 1,
  ): void {
    rig?.hitstop(0.085, 0.02);
    take(this.impacts).restart(at, UP, power, 'ground');
    take(this.quakes).restart(at, direction, power);
  }

  /** Directional Cây Đổ payoff: bark and roots keep travelling away from Groot after he stops. */
  knockback(
    at: THREE.Vector3,
    direction: THREE.Vector3,
    rig?: { hitstop(seconds: number, scale?: number): void },
    power = 1,
  ): void {
    rig?.hitstop(0.088, 0.018);
    take(this.impacts).restart(at, direction, power, 'lash');
    take(this.quakes).restart(at, direction, power * 0.82);
  }

  aftershock(at: THREE.Vector3, direction: THREE.Vector3, power = 0.65): void {
    take(this.quakes).restart(at, direction, power);
  }

  taken(at: THREE.Vector3, direction: THREE.Vector3): void {
    take(this.impacts).restart(at, direction, 0.72, 'taken');
  }

  hitWard(rig?: { hitstop(seconds: number, scale?: number): void }): void {
    rig?.hitstop(0.052, 0.04);
    this.ward.hit();
  }

  castSeed(from: THREE.Object3D, direction: THREE.Vector3, reachInHeights = 0.76, flight = 0.58): void {
    take(this.seeds).restart(from, direction, reachInHeights * this.scale, flight);
  }

  releaseCanopy(at: THREE.Vector3): void {
    this.canopy.release();
    take(this.impacts).restart(at, UP, 1.12, 'ground');
  }

  update(dt: number, elapsed: number): void {
    this.breath.tick(dt, elapsed);
    this.canopy.tick(dt, elapsed);
    this.handGather.tick(dt, elapsed);
    this.ward.tick(dt, elapsed);
    for (const lash of this.lashes) lash.tick(dt, elapsed);
    for (const impact of this.impacts) impact.tick(dt, elapsed);
    for (const quake of this.quakes) quake.tick(dt, elapsed);
    for (const seed of this.seeds) seed.tick(dt, elapsed);
  }

  get liveEffects(): number {
    let n = this.breath.strength > 0.005 ? 1 : 0;
    if (this.canopy.strength > 0.005) n += 1;
    if (Math.max(this.handGather.left, this.handGather.right) > 0.005) n += 1;
    if (this.ward.strength > 0.005) n += 1;
    for (const lash of this.lashes) if (lash.alive) n += 1;
    for (const impact of this.impacts) if (impact.alive) n += 1;
    for (const quake of this.quakes) if (quake.alive) n += 1;
    for (const seed of this.seeds) if (seed.alive) n += 1;
    return n;
  }
}
