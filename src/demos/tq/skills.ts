import * as THREE from 'three';
import type { TqCharacter } from './createTqCharacter';
import { SIGNATURE, REGIONS } from './characterPalette';
import { AuraShell, DragonSigil, EmberField, ShockRing, TrailRibbon, type Effect } from './vfx';
import type { StageLights } from './lighting';

/**
 * Attack skills: a clip, plus a timeline of effects hung off real sockets.
 *
 * The rig shipped 24 retargeted clips and no combat design. These four skills are built ON those
 * clips — `chop`, `cast_a_spell`, `box_02` and `flip` — rather than on invented motion, so the
 * character's body is really doing the thing the effect claims. Timings are expressed as a fraction
 * of the clip's own duration, so a skill stays in sync with the animation it belongs to.
 *
 * Naming follows the reference: a Three Kingdoms officer in crimson lacquer with gold dragon-and-
 * cloud filigree and a dragon-head belt buckle. The skills are hers — a blade arc, a cast seal, a
 * fist volley, a leaping strike — not a generic elemental kit.
 *
 * Every anchor below is a socket id from `sockets.ts`, and every socket is on a named bone of the
 * rig. There is not a stage coordinate anywhere in this file.
 */

export interface SkillDefinition {
  id: string;
  name: string;
  /** The character-appropriate title, for the UI. */
  title: string;
  clip: string;
  description: string;
  /** Ribbon trails: socket id plus the window, as a fraction of clip duration, when it is drawn. */
  trails?: { socket: string; from: number; to: number; width?: number; inner?: THREE.Color; outer?: THREE.Color }[];
  /** One-off ember bursts. */
  bursts?: { socket: string; at: number; count: number }[];
  /** Continuous ember emission windows. */
  emit?: { socket: string; from: number; to: number; rate: number }[];
  sigil?: { socket: string; at: number; duration: number; radius: number; faceCamera?: boolean };
  ring?: { socket: string; at: number; radius: number; duration: number; colour?: THREE.Color };
  /** Aura strength envelope: rises to `peak` between `from` and `mid`, falls away by `to`. */
  aura?: { from: number; mid: number; to: number; peak: number; colour?: THREE.Color };
  /** Emissive pulse on the gold filigree — the existing material channel, not a new object. */
  emissive?: { from: number; mid: number; to: number; peak: number };
  /** Accent lamp envelope, so the room reacts and not only the effect. */
  accent?: { from: number; mid: number; to: number; peak: number };
}

export const SKILLS: readonly SkillDefinition[] = [
  {
    id: 'crimson-arc',
    name: 'Crimson Arc',
    title: '烈斬 · Liệt Trảm',
    clip: 'preset:biped:chop',
    description: 'A downward cut. The blade she is not holding is drawn by the arc her hand leaves.',
    // `tools/motionProbe.ts`: the right hand spikes to 7.67 m/s at t=0.317 and is above half that
    // for only 0.308..0.325 — a long windup and a very short strike. Timing this by eye put the
    // ribbon on screen while the hand was still nearly stationary.
    trails: [{ socket: 'grip.right', from: 0.24, to: 0.45, width: 0.09 }],
    bursts: [
      { socket: 'grip.right', at: 0.325, count: 55 },
      { socket: 'attachment.foot.right', at: 0.34, count: 30 },
    ],
    ring: { socket: 'attachment.foot.right', at: 0.335, radius: 1.5, duration: 0.85 },
    aura: { from: 0.18, mid: 0.32, to: 0.55, peak: 0.5 },
    emissive: { from: 0.18, mid: 0.32, to: 0.6, peak: 1.5 },
    accent: { from: 0.2, mid: 0.33, to: 0.6, peak: 6 },
  },
  {
    id: 'dragon-seal',
    name: 'Dragon Seal',
    title: '龍印 · Long Ấn',
    clip: 'preset:biped:cast_a_spell',
    description: 'The cuirass roundel opens into a cloud-scroll seal, drawn in her own gold.',
    // Measured: both hands sweep from t=0.158 to 0.458, peaking at 0.217. The seal blooms just
    // after that first sweep, which is the gesture that reads as casting it.
    sigil: { socket: 'effect.chest', at: 0.22, duration: 2.4, radius: 0.85, faceCamera: true },
    emit: [
      { socket: 'grip.left', from: 0.16, to: 0.6, rate: 70 },
      { socket: 'grip.right', from: 0.16, to: 0.6, rate: 70 },
    ],
    bursts: [{ socket: 'effect.chest', at: 0.24, count: 45 }],
    aura: { from: 0.14, mid: 0.3, to: 0.75, peak: 0.4, colour: SIGNATURE.gold },
    emissive: { from: 0.14, mid: 0.3, to: 0.75, peak: 1.9 },
    accent: { from: 0.15, mid: 0.3, to: 0.75, peak: 7 },
  },
  {
    id: 'gale-volley',
    name: 'Gale Volley',
    title: '旋風 · Toàn Phong',
    clip: 'preset:biped:box_02',
    description: 'A fist combination. Two ribbons, one per hand, crossing in front of the cuirass.',
    // box_02 was chosen by measurement, not by name: its right hand reaches 7.66 m/s at t=0.750,
    // against 1.19 for box_01 and 0.97 for box_03. The punch lands late in the clip.
    trails: [
      { socket: 'grip.right', from: 0.52, to: 0.88, width: 0.055 },
      { socket: 'grip.left', from: 0.52, to: 0.88, width: 0.055, inner: SIGNATURE.gold, outer: SIGNATURE.indigo },
    ],
    bursts: [
      { socket: 'grip.right', at: 0.62, count: 30 },
      { socket: 'grip.left', at: 0.72, count: 30 },
      { socket: 'grip.right', at: 0.79, count: 45 },
    ],
    aura: { from: 0.5, mid: 0.72, to: 0.95, peak: 0.4 },
    emissive: { from: 0.5, mid: 0.72, to: 0.95, peak: 1.1 },
    accent: { from: 0.5, mid: 0.72, to: 0.95, peak: 4 },
  },
  {
    id: 'phoenix-rise',
    name: 'Phoenix Rise',
    title: '鳳翔 · Phượng Tường',
    clip: 'preset:biped:flip',
    description: 'A leaping turn. The ribbon comes off the boots, and the floor answers on landing.',
    // Measured: the feet peak at 7.81 and 8.73 m/s around t=0.45-0.48, and the crown stays in
    // motion from 0.275 to 0.658. The landing burst is placed just after the feet come back down.
    trails: [
      { socket: 'attachment.foot.right', from: 0.3, to: 0.6, width: 0.07 },
      { socket: 'effect.crown', from: 0.28, to: 0.66, width: 0.05, inner: SIGNATURE.gold, outer: SIGNATURE.crimson },
    ],
    emit: [{ socket: 'effect.pelvis', from: 0.3, to: 0.65, rate: 90 }],
    bursts: [{ socket: 'attachment.foot.left', at: 0.6, count: 70 }],
    ring: { socket: 'attachment.foot.left', at: 0.6, radius: 2.1, duration: 1.0, colour: SIGNATURE.crimson },
    aura: { from: 0.25, mid: 0.45, to: 0.8, peak: 0.38, colour: SIGNATURE.gold },
    emissive: { from: 0.25, mid: 0.45, to: 0.8, peak: 1.3 },
    accent: { from: 0.28, mid: 0.48, to: 0.8, peak: 5 },
  },
];

/** Rise to a peak at `mid`, fall back to zero by `to`. Smooth at both ends. */
function envelope(t: number, from: number, mid: number, to: number, peak: number): number {
  if (t <= from || t >= to) return 0;
  const x = t < mid ? (t - from) / Math.max(1e-6, mid - from) : 1 - (t - mid) / Math.max(1e-6, to - mid);
  return peak * THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(x, 0, 1), 0, 1);
}

/**
 * Runs one skill at a time and keeps every effect fed with its socket's current world position.
 *
 * The persistent systems (ember pool, two ribbons, the aura shell) are built once and reused; only
 * rings and sigils are created per cast, because they are genuinely one-shot. Transients are
 * removed the frame they report they are finished, so a long session does not accumulate objects.
 */
export class SkillDirector {
  readonly group = new THREE.Group();
  private readonly embers: EmberField;
  private readonly trails = new Map<string, TrailRibbon>();
  private readonly aura: AuraShell;
  private readonly transients: Effect[] = [];
  private active: SkillDefinition | null = null;
  private clipDuration = 0;
  private elapsed = 0;
  private readonly fired = new Set<string>();
  private readonly goldMaterial: THREE.MeshPhysicalMaterial | null;
  private readonly baseEmissiveIntensity: number;
  private readonly world = new THREE.Vector3();
  private readonly standOff = new THREE.Vector3();
  /** Called when a skill finishes on its own, so a caller's UI can stop showing it as active. */
  onRelease: (() => void) | null = null;

  constructor(
    private readonly character: TqCharacter,
    private readonly lights: StageLights,
  ) {
    this.group.name = 'tq:vfx';

    this.embers = new EmberField({ count: 900, rate: 0, radius: 0.05, life: 1.25, seed: 0x7a11 });
    this.group.add(this.embers.object);

    // One ribbon per socket that any skill trails from, built up front rather than per cast.
    const socketIds = new Set<string>();
    for (const skill of SKILLS) for (const trail of skill.trails ?? []) socketIds.add(trail.socket);
    for (const id of socketIds) {
      const ribbon = new TrailRibbon({ samples: 28 });
      this.trails.set(id, ribbon);
      this.group.add(ribbon.object);
    }

    // The aura traces the costume's real silhouette, so it is built from the costume meshes.
    const costume = [...character.meshes.entries()]
      .filter(([id]) => id !== 'skin')
      .map(([, mesh]) => mesh);
    this.aura = new AuraShell(costume, SIGNATURE.crimson, 0.0035);
    character.figure.add(this.aura.object);

    const gold = character.meshes.get('filigree-gold');
    this.goldMaterial = (gold?.material as THREE.MeshPhysicalMaterial) ?? null;
    if (this.goldMaterial) {
      // Light the existing emissive channel rather than adding a glowing duplicate of the filigree.
      this.goldMaterial.emissive = new THREE.Color(REGIONS['filigree-gold'].emissive);
      this.goldMaterial.emissiveIntensity = 0;
    }
    this.baseEmissiveIntensity = 0;
  }

  get activeSkill(): SkillDefinition | null {
    return this.active;
  }

  /** Fire a skill by id. Returns false if the id is unknown or its clip is missing from the rig. */
  cast(id: string, fadeSeconds = 0.22): boolean {
    const skill = SKILLS.find((s) => s.id === id);
    if (!skill) return false;
    const clip = this.character.clips.find((c) => c.name === skill.clip);
    if (!clip) return false;

    this.character.play(skill.clip, fadeSeconds);
    this.active = skill;
    this.clipDuration = clip.duration;
    this.elapsed = 0;
    this.fired.clear();
    for (const ribbon of this.trails.values()) {
      ribbon.clear();
      ribbon.opacity = 0;
    }
    return true;
  }

  /** Stop the skill's effects and return to an idle look. The clip is the caller's business. */
  release(): void {
    const wasActive = this.active !== null;
    this.active = null;
    this.embers.rate = 0;
    for (const ribbon of this.trails.values()) ribbon.opacity = 0;
    this.aura.strength = 0;
    this.lights.accent.intensity = 0;
    if (this.goldMaterial) this.goldMaterial.emissiveIntensity = this.baseEmissiveIntensity;
    if (wasActive) this.onRelease?.();
  }

  /** World position of a socket right now, or null if the socket id is unknown. */
  private socketWorld(id: string): THREE.Vector3 | null {
    const node = this.character.sockets.get(id);
    if (!node) return null;
    node.getWorldPosition(this.world);
    return this.world;
  }

  update(dt: number, camera: THREE.Camera): void {
    const skill = this.active;

    if (skill) {
      this.elapsed += dt;
      // Fraction through the clip. Skills run once and then release, so this is not wrapped.
      const t = this.clipDuration > 0 ? this.elapsed / this.clipDuration : 1;

      // --- trails ---
      for (const trail of skill.trails ?? []) {
        const ribbon = this.trails.get(trail.socket);
        const at = this.socketWorld(trail.socket);
        if (!ribbon || !at) continue;
        const on = t >= trail.from && t <= trail.to;
        // Fade the ribbon in and out rather than switching it, or the arc appears mid-air.
        const span = Math.max(1e-6, (trail.to - trail.from) * 0.25);
        ribbon.opacity = on
          ? Math.min(1, Math.min((t - trail.from) / span, (trail.to - t) / span))
          : Math.max(0, ribbon.opacity - dt * 4);
        if (on) ribbon.push(at, camera.position);
      }

      // --- continuous emission ---
      let emitting = false;
      for (const emit of skill.emit ?? []) {
        if (t >= emit.from && t <= emit.to) {
          const at = this.socketWorld(emit.socket);
          if (at) {
            this.embers.setAnchor(at);
            this.embers.rate = emit.rate;
            emitting = true;
          }
        }
      }
      if (!emitting) this.embers.rate = 0;

      // --- one-shot bursts ---
      for (let i = 0; i < (skill.bursts ?? []).length; i += 1) {
        const burst = skill.bursts![i];
        const key = `burst:${String(i)}`;
        if (t >= burst.at && !this.fired.has(key)) {
          const at = this.socketWorld(burst.socket);
          if (at) {
            this.embers.setAnchor(at);
            this.embers.burst(burst.count);
          }
          this.fired.add(key);
        }
      }

      // --- sigil ---
      if (skill.sigil && t >= skill.sigil.at && !this.fired.has('sigil')) {
        const at = this.socketWorld(skill.sigil.socket);
        if (at) {
          const sigil = new DragonSigil(skill.sigil.duration, skill.sigil.radius, SIGNATURE.gold, SIGNATURE.crimson);
          sigil.object.position.copy(at);
          if (skill.sigil.faceCamera) sigil.object.lookAt(camera.position);
          this.group.add(sigil.object);
          this.transients.push(sigil);
        }
        this.fired.add('sigil');
      }

      // --- ground ring ---
      if (skill.ring && t >= skill.ring.at && !this.fired.has('ring')) {
        const at = this.socketWorld(skill.ring.socket);
        if (at) {
          // The ring belongs on the floor under the contact point, not at the ankle's height.
          const ground = new THREE.Vector3(at.x, this.character.group.position.y, at.z);
          const ring = new ShockRing(ground, skill.ring.radius, skill.ring.duration, skill.ring.colour ?? SIGNATURE.gold);
          this.group.add(ring.object);
          this.transients.push(ring);
        }
        this.fired.add('ring');
      }

      // --- envelopes ---
      this.aura.strength = skill.aura ? envelope(t, skill.aura.from, skill.aura.mid, skill.aura.to, skill.aura.peak) : 0;
      this.lights.accent.intensity = skill.accent
        ? envelope(t, skill.accent.from, skill.accent.mid, skill.accent.to, skill.accent.peak)
        : 0;
      if (this.goldMaterial && skill.emissive) {
        this.goldMaterial.emissiveIntensity = envelope(t, skill.emissive.from, skill.emissive.mid, skill.emissive.to, skill.emissive.peak);
      }
      // The accent lamp follows the chest socket, but STANDS OFF from it toward the viewer.
      //
      // Parked exactly on the socket it sits on the cuirass surface, and with `decay: 2` the
      // irradiance a few centimetres away is enormous — the armour went white while the skirt
      // below stayed correctly lit. Half a metre out it reads as a lamp lighting her rather than
      // as a lamp buried inside her.
      const chest = this.socketWorld('effect.chest');
      if (chest) {
        this.standOff.subVectors(camera.position, chest);
        const distance = this.standOff.length();
        if (distance > 1e-4) this.standOff.multiplyScalar(0.5 / distance);
        else this.standOff.set(0, 0, 0.5);
        this.lights.accent.position.copy(chest).add(this.standOff);
      }

      if (t >= 1) this.release();
    }

    this.embers.update(dt);
    for (const ribbon of this.trails.values()) ribbon.update();
    this.aura.update(dt);

    // Retire finished transients; iterate backwards so removal does not skip the next one.
    for (let i = this.transients.length - 1; i >= 0; i -= 1) {
      if (!this.transients[i].update(dt, this.elapsed)) {
        this.group.remove(this.transients[i].object);
        this.transients[i].dispose();
        this.transients.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.embers.dispose();
    for (const ribbon of this.trails.values()) ribbon.dispose();
    this.aura.dispose();
    for (const transient of this.transients) transient.dispose();
    this.transients.length = 0;
  }
}
