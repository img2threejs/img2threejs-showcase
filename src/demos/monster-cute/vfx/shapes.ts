/**
 * The non-particle effect shapes: ground shockwaves, the arc between the horns, a charge orb, a
 * palm beam, and the hearts.
 *
 * HAND-WRITTEN — see the note in `particles.ts`.
 *
 * Everything in here is pooled and hidden rather than created and destroyed, because these fire
 * during animation and a `new Mesh` mid-clip is a frame hitch.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- shockwave

/**
 * Expanding ground rings.
 *
 * A ring, not a sphere: this fires when a foot lands, and the shape of that event is a disturbance
 * travelling out along the floor. It is drawn with `depthWrite` off and a small lift off Y = 0 so
 * it does not z-fight the ground plane.
 */
export class Shockwaves {
  readonly group = new THREE.Group();
  private readonly pool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; age: number; life: number; radius: number }[] = [];

  constructor(count: number, colour: THREE.Color) {
    for (let i = 0; i < count; i += 1) {
      // Inner radius 0.62 of the outer: a thin band reads as a wave, a thick one as a puddle.
      const geometry = new THREE.RingGeometry(0.55, 1, 72);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        color: colour.clone(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.pool.push({ mesh, material, age: 0, life: 0, radius: 1 });
    }
  }

  get liveCount(): number { return this.pool.filter((s) => s.mesh.visible).length; }

  fire(at: THREE.Vector3, radius: number, life: number, colour?: THREE.Color): void {
    const slot = this.pool.find((s) => !s.mesh.visible) ?? this.pool.reduce((a, b) => (a.age > b.age ? a : b));
    slot.mesh.position.set(at.x, 0.004, at.z);
    slot.mesh.scale.setScalar(0.001);
    slot.mesh.visible = true;
    slot.age = 0;
    slot.life = life;
    slot.radius = radius;
    if (colour) slot.material.color.copy(colour);
  }

  update(dt: number): void {
    for (const slot of this.pool) {
      if (!slot.mesh.visible) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) { slot.mesh.visible = false; slot.material.opacity = 0; continue; }
      // Decelerating expansion: a wave is fastest the instant it is made.
      slot.mesh.scale.setScalar(slot.radius * (1 - (1 - t) ** 2.2));
      slot.material.opacity = (1 - t) ** 1.4;
    }
  }

  dispose(): void { for (const s of this.pool) { s.mesh.geometry.dispose(); s.material.dispose(); } }
}

// ---------------------------------------------------------------- horn arc

/**
 * An electric arc strung between the two horns.
 *
 * This is the one effect that exists because of what the character *is*: the horns are the only
 * hard, paired, non-fur feature the measurement found, and an arc needs two endpoints that belong
 * together. The endpoints are the two measured horn-tip sockets, so the arc tracks the head
 * through every clip without a single authored coordinate.
 */
export class HornArc {
  readonly group = new THREE.Group();
  private readonly line: THREE.LineSegments;
  private readonly core: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly corePositions: Float32Array;
  private readonly material: THREE.LineBasicMaterial;
  private readonly coreMaterial: THREE.LineBasicMaterial;
  private readonly segments: number;
  private strength = 0;
  private sinceRebuild = 0;
  private seed = 1;

  constructor(segments: number, colour: THREE.Color, coreColour: THREE.Color) {
    this.segments = segments;
    this.positions = new Float32Array(segments * 2 * 3);
    this.corePositions = new Float32Array(segments * 2 * 3);

    const make = (buffer: Float32Array, material: THREE.LineBasicMaterial) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(buffer, 3));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);
      const line = new THREE.LineSegments(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 11;
      return line;
    };
    this.material = new THREE.LineBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.coreMaterial = new THREE.LineBasicMaterial({ color: coreColour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.line = make(this.positions, this.material);
    this.core = make(this.corePositions, this.coreMaterial);
    this.group.add(this.line, this.core);
    this.group.visible = false;
  }

  setStrength(value: number): void { this.strength = value; }

  get opacity(): number { return this.material.opacity; }

  /** Deterministic jitter: a seeded LCG, so a recorded run replays identically. */
  private random(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  private rebuild(a: THREE.Vector3, b: THREE.Vector3, spread: number): void {
    const along = new THREE.Vector3().subVectors(b, a);
    const length = along.length();
    // Two perpendiculars to displace along, so the bolt is crooked in 3D rather than in a plane.
    const up = Math.abs(along.y) > 0.9 * length ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const p1 = new THREE.Vector3().crossVectors(along, up).normalize();
    const p2 = new THREE.Vector3().crossVectors(along, p1).normalize();

    const point = (t: number, scale: number, out: THREE.Vector3) => {
      out.copy(a).addScaledVector(along, t);
      // The arc bows upward at the middle and is pinned at both horns.
      const envelope = Math.sin(Math.PI * t);
      out.addScaledVector(p1, (this.random() - 0.5) * spread * envelope * scale);
      out.addScaledVector(p2, (this.random() - 0.5) * spread * envelope * scale);
      out.y += envelope * spread * 0.45 * scale;
    };

    const write = (buffer: Float32Array, scale: number) => {
      const previous = new THREE.Vector3();
      const current = new THREE.Vector3();
      point(0, scale, previous);
      for (let i = 0; i < this.segments; i += 1) {
        point((i + 1) / this.segments, scale, current);
        buffer[i * 6] = previous.x; buffer[i * 6 + 1] = previous.y; buffer[i * 6 + 2] = previous.z;
        buffer[i * 6 + 3] = current.x; buffer[i * 6 + 4] = current.y; buffer[i * 6 + 5] = current.z;
        previous.copy(current);
      }
    };
    write(this.positions, 1);
    write(this.corePositions, 0.35);
    (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.core.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, left: THREE.Vector3, right: THREE.Vector3, spread: number): void {
    const opacity = this.material.opacity + (this.strength - this.material.opacity) * Math.min(1, dt * 9);
    this.material.opacity = opacity;
    this.coreMaterial.opacity = Math.min(1, opacity * 0.9);
    this.group.visible = opacity > 0.01;
    if (!this.group.visible) return;

    // Rebuild at 30 Hz regardless of frame rate: an arc that re-randomises every frame at 120 fps
    // reads as a smear, and one that re-randomises at 20 fps reads as a stutter.
    this.sinceRebuild += dt;
    if (this.sinceRebuild >= 1 / 30) {
      this.sinceRebuild = 0;
      this.rebuild(left, right, spread);
    }
  }

  dispose(): void {
    this.line.geometry.dispose(); this.core.geometry.dispose();
    this.material.dispose(); this.coreMaterial.dispose();
  }
}

// ---------------------------------------------------------------- charge orb

/**
 * A glow that gathers in a palm.
 *
 * Two nested spheres with additive blending and no depth write: the outer one is the halo, the
 * inner the hot centre. A point light rides with it so the effect actually lights the fur it sits
 * against instead of floating in front of it.
 */
export class ChargeOrb {
  readonly group = new THREE.Group();
  private readonly halo: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  readonly light: THREE.PointLight;
  private charge = 0;
  private target = 0;

  constructor(radius: number, colour: THREE.Color, coreColour: THREE.Color) {
    this.haloMaterial = new THREE.MeshBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.coreMaterial = new THREE.MeshBasicMaterial({ color: coreColour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 16), this.haloMaterial);
    this.core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.45, 16, 12), this.coreMaterial);
    this.light = new THREE.PointLight(colour.clone(), 0, radius * 14, 2);
    this.halo.renderOrder = 10;
    this.core.renderOrder = 11;
    this.group.add(this.halo, this.core, this.light);
    this.group.visible = false;
  }

  setCharge(value: number): void { this.target = value; }
  get level(): number { return this.charge; }

  update(dt: number, elapsed: number): void {
    this.charge += (this.target - this.charge) * Math.min(1, dt * 6);
    this.group.visible = this.charge > 0.01;
    if (!this.group.visible) return;
    // A charge that sits perfectly still reads as a decal; the flicker is what makes it energy.
    const flicker = 0.88 + 0.12 * Math.sin(elapsed * 21) * Math.sin(elapsed * 7.3);
    const scale = this.charge * flicker;
    this.halo.scale.setScalar(scale);
    this.core.scale.setScalar(scale * (0.9 + 0.3 * Math.sin(elapsed * 13)));
    this.haloMaterial.opacity = 0.6 * this.charge;
    this.coreMaterial.opacity = 0.9 * this.charge;
    this.light.intensity = 3.4 * this.charge * flicker;
  }

  dispose(): void {
    this.halo.geometry.dispose(); this.core.geometry.dispose();
    this.haloMaterial.dispose(); this.coreMaterial.dispose();
  }
}

// ---------------------------------------------------------------- beam

/**
 * A bolt fired from a palm.
 *
 * A cylinder built along +Y once and then oriented with `quaternion.setFromUnitVectors`, so the
 * per-shot cost is a quaternion rather than new geometry. It extends from the palm toward the
 * direction the head is facing — which is itself measured, not assumed.
 */
export class Beam {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly from = new THREE.Vector3();
  private readonly direction = new THREE.Vector3(0, 1, 0);
  private age = 0;
  private life = 0;
  private reach = 1;
  private thickness = 0.1;

  constructor(colour: THREE.Color) {
    // Unit cylinder along +Y, origin at its base, so scaling Y grows it forward from the palm.
    const geometry = new THREE.CylinderGeometry(1, 0.35, 1, 14, 1, true);
    geometry.translate(0, 0.5, 0);
    this.material = new THREE.MeshBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  fire(from: THREE.Vector3, direction: THREE.Vector3, reach: number, thickness: number, life: number): void {
    this.from.copy(from);
    this.direction.copy(direction).normalize();
    this.reach = reach;
    this.thickness = thickness;
    this.life = life;
    this.age = 0;
    this.group.visible = true;
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.direction);
  }

  /** Where the bolt's head is right now — the impact burst spawns here. */
  tipAt(t: number): THREE.Vector3 {
    return this.from.clone().addScaledVector(this.direction, this.reach * Math.min(1, t * 1.6));
  }

  get running(): boolean { return this.group.visible; }
  get progress(): number { return this.life ? this.age / this.life : 1; }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.age += dt;
    const t = this.age / this.life;
    if (t >= 1) { this.group.visible = false; return; }
    // Shoots out fast, then thins and fades rather than retracting.
    const extend = Math.min(1, t * 1.6);
    this.mesh.position.copy(this.from);
    this.mesh.scale.set(this.thickness * (1 - t) ** 0.6, this.reach * extend, this.thickness * (1 - t) ** 0.6);
    this.material.opacity = (1 - t) ** 1.3;
  }

  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- hearts

/** A heart outline, drawn once as a `THREE.Shape` and reused by every instance. */
function heartGeometry(size: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const s = size;
  shape.moveTo(0, -0.9 * s);
  shape.bezierCurveTo(-1.1 * s, 0.15 * s, -0.55 * s, 1.0 * s, 0, 0.45 * s);
  shape.bezierCurveTo(0.55 * s, 1.0 * s, 1.1 * s, 0.15 * s, 0, -0.9 * s);
  return new THREE.ShapeGeometry(shape, 16);
}

/**
 * Hearts that rise off the chest.
 *
 * Here because of what the subject is rather than what the rig can do: it is a round, blue, fanged
 * cartoon monster, and the clip set it shipped with includes a heart pose. Billboarded to the
 * camera each frame, since a flat shape seen edge-on disappears.
 */
export class Hearts {
  readonly group = new THREE.Group();
  private readonly pool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; velocity: THREE.Vector3; age: number; life: number; spin: number }[] = [];

  constructor(count: number, size: number, colour: THREE.Color) {
    const geometry = heartGeometry(size);
    for (let i = 0; i < count; i += 1) {
      // Additive, like every other effect here. Drawn as a normal transparent material the violet
      // came out near-black: ACES tone mapping compresses a mid-lightness flat colour hard, and
      // there is nothing behind it on this background to lift it back up.
      const material = new THREE.MeshBasicMaterial({
        color: colour.clone(), transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.pool.push({ mesh, material, velocity: new THREE.Vector3(), age: 0, life: 0, spin: 0 });
    }
  }

  get liveCount(): number { return this.pool.filter((s) => s.mesh.visible).length; }

  emit(at: THREE.Vector3, velocity: THREE.Vector3, life: number): void {
    const slot = this.pool.find((s) => !s.mesh.visible);
    if (!slot) return;
    slot.mesh.position.copy(at);
    slot.mesh.visible = true;
    slot.velocity.copy(velocity);
    slot.age = 0;
    slot.life = life;
    slot.spin = (Math.random() - 0.5) * 2.4;
  }

  update(dt: number, cameraQuaternion: THREE.Quaternion): void {
    for (const slot of this.pool) {
      if (!slot.mesh.visible) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) { slot.mesh.visible = false; continue; }
      slot.mesh.position.addScaledVector(slot.velocity, dt);
      slot.velocity.x += Math.sin(slot.age * 3 + slot.spin * 4) * dt * 0.25;   // drift, so they do not rise in a column
      slot.mesh.quaternion.copy(cameraQuaternion);
      slot.mesh.rotateZ(Math.sin(slot.age * 2.2 + slot.spin) * 0.35);
      slot.mesh.scale.setScalar(0.4 + 0.6 * Math.min(1, t * 5));
      slot.material.opacity = Math.min(1, t * 6) * (1 - t) ** 1.4;
    }
  }

  dispose(): void {
    this.pool[0]?.mesh.geometry.dispose();
    for (const s of this.pool) s.material.dispose();
  }
}
