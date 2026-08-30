import * as THREE from 'three';
import type { TqCharacter } from './createTqCharacter';
import { SIGNATURE, REGIONS } from './characterPalette';
import {
  AirFracture,
  AuraShell,
  BrushSlash,
  FormationArray,
  InkBurst,
  LotusBloom,
  SilkRibbon,
  SpiritDragon,
  SpiritFlame,
  TalismanSwarm,
  type Effect,
} from './vfx';
import type { StageLights } from './lighting';

/**
 * Attack skills: a clip, plus a timeline of effects hung off real sockets.
 *
 * The rig shipped 24 retargeted clips and no combat design. These four skills are built ON those
 * clips — `chop`, `cast_a_spell`, `box_02` and `flip` — rather than on invented motion, so the
 * character's body is really doing the thing the effect claims.
 *
 * The staging follows how these moments are shot in Chinese animated features rather than how a
 * game engine usually sprays particles:
 *
 *   - a beat of ANTICIPATION before anything bright happens, so the release lands
 *   - the ink and the array are INSCRIBED over time, never switched on whole
 *   - one clear silhouette per skill — a stroke, a coiling dragon, two ribbons, a flower — rather
 *     than several effects competing for the same frame
 *   - the biggest element arrives LAST, on the beat the body commits
 *
 * Timings are fractions of each clip's own duration and come from `tools/motionProbe.ts`, which
 * measured where each socket actually reaches peak speed. Every anchor is a socket id from
 * `sockets.ts`; there is not a stage coordinate in this file.
 */

export interface SkillDefinition {
  id: string;
  name: string;
  /** The character-appropriate title, for the UI. */
  title: string;
  clip: string;
  description: string;
  /**
   * Playback rate for the clip.
   *
   * The retargeted presets run long — `chop` is 6.63 seconds, and the swing inside it lasts about
   * 0.11 — so at rate 1 a skill reads as a slow demonstration rather than a strike, and the brush
   * stroke has almost no arc to be drawn along. Each rate below brings its clip to roughly two to
   * three seconds, which is where the attacks read as attacks.
   */
  rate?: number;

  /** 筆鋒 — a calligraphic stroke laid along a socket's path. */
  slash?: { socket: string; from: number; to: number; width?: number };
  /** 綢帶 — silk ribbons that lag behind a socket. */
  ribbons?: { socket: string; from: number; to: number; width?: number; inner?: THREE.Color; outer?: THREE.Color }[];
  /** 水墨 — continuous ink/spark emission windows. */
  emit?: { socket: string; from: number; to: number; rate: number; sparkRatio?: number }[];
  /** 水墨 — one-off ink and spark bursts. */
  bursts?: { socket: string; at: number; count: number; speed?: number; radius?: number; sparkRatio?: number }[];
  /**
   * 法陣 — the array.
   *
   * `ground` lays it on the floor, `facing` stands it up facing the viewer, and `arm` casts it off
   * the pointing hand with its normal down the arm, so the seal reads as being projected rather
   * than as scenery standing behind the caster.
   */
  array?: { socket: string; at: number; duration: number; radius: number; orient?: 'ground' | 'facing' | 'arm' };
  /** 神龍 — the coiling dragon. `arm` sends it out along the pointing arm instead of straight up. */
  dragon?: { socket: string; at: number; duration: number; height: number; radius: number; orient?: 'up' | 'arm' };
  /** 符籙 — a fan of talismans. */
  talismans?: { socket: string; at: number; count: number; duration: number };
  /** 蓮華 — a lotus opening on the ground. */
  lotus?: { socket: string; at: number; scale: number; duration: number };
  /** 空間裂痕 — tears in the air. Several can be thrown from one cue, scattered around the socket. */
  fractures?: { socket: string; at: number; count: number; radius: number; duration: number; spread?: number }[];
  /** 焚身火焰 — the standing fire, as an envelope rather than a one-shot. */
  flame?: { from: number; mid: number; to: number; peak: number };

  /** Aura strength envelope, and the colour the rim takes for this skill. */
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
    rate: 2.4,
    description: 'One cut, written as one brush stroke — pressed through the belly, dry at the tail.',
    // Measured: the right hand spikes to 7.67 m/s at t=0.317 and is above half that for only
    // 0.308..0.325. A long windup and a very short strike, so the stroke is laid down fast and the
    // impact lands on the frame the hand actually arrives.
    slash: { socket: 'grip.right', from: 0.27, to: 0.42, width: 0.5 },
    bursts: [
      { socket: 'grip.right', at: 0.325, count: 120, speed: 2.1, radius: 0.09, sparkRatio: 0.5 },
      { socket: 'attachment.foot.right', at: 0.34, count: 70, speed: 1.5, radius: 0.12, sparkRatio: 0.25 },
    ],
    array: { socket: 'attachment.foot.right', at: 0.33, duration: 1.15, radius: 1.35 },
    // The cut does not just land — it splits the air it passed through.
    fractures: [{ socket: 'grip.right', at: 0.33, count: 2, radius: 0.8, duration: 0.85, spread: 0.5 }],
    flame: { from: 0.2, mid: 0.36, to: 0.7, peak: 0.75 },
    aura: { from: 0.18, mid: 0.32, to: 0.55, peak: 0.55 },
    emissive: { from: 0.18, mid: 0.32, to: 0.6, peak: 1.5 },
    accent: { from: 0.2, mid: 0.33, to: 0.6, peak: 6 },
  },
  {
    id: 'dragon-seal',
    name: 'Dragon Seal',
    title: '龍印 · Long Ấn',
    clip: 'preset:biped:cast_a_spell',
    rate: 1.6,
    description: 'The seal is inscribed off her palm and the dragon runs out along the arm she points with.',
    // Measured: both hands sweep from t=0.158 to 0.458, peaking at 0.217. The array is drawn on
    // that first sweep, the talismans leave the hands just after, and the dragon — the largest
    // thing on screen — arrives last, once the body has committed to the cast.
    array: { socket: 'grip.right', at: 0.28, duration: 2.6, radius: 0.8, orient: 'arm' },
    talismans: { socket: 'effect.chest', at: 0.24, count: 20, duration: 2.4 },
    dragon: { socket: 'grip.right', at: 0.32, duration: 2.6, height: 2.6, radius: 0.5, orient: 'arm' },
    emit: [
      { socket: 'grip.left', from: 0.16, to: 0.6, rate: 55, sparkRatio: 0.7 },
      { socket: 'grip.right', from: 0.16, to: 0.6, rate: 55, sparkRatio: 0.7 },
    ],
    bursts: [{ socket: 'effect.chest', at: 0.24, count: 60, speed: 1.2, radius: 0.1, sparkRatio: 0.6 }],
    flame: { from: 0.2, mid: 0.5, to: 0.9, peak: 0.6 },
    aura: { from: 0.14, mid: 0.36, to: 0.8, peak: 0.5, colour: SIGNATURE.gold },
    emissive: { from: 0.14, mid: 0.36, to: 0.8, peak: 1.9 },
    accent: { from: 0.15, mid: 0.36, to: 0.8, peak: 7 },
  },
  {
    id: 'gale-volley',
    name: 'Gale Volley',
    title: '旋風 · Toàn Phong',
    clip: 'preset:biped:box_02',
    rate: 1.15,
    description: 'A fist combination trailing two apsara ribbons that cross in front of the cuirass.',
    // box_02 was chosen by measurement, not by name: its right hand reaches 7.66 m/s at t=0.750,
    // against 1.19 for box_01 and 0.97 for box_03. The punch lands late, so the ribbons are already
    // flying by the time it arrives.
    ribbons: [
      { socket: 'grip.right', from: 0.44, to: 0.95, width: 0.085 },
      { socket: 'grip.left', from: 0.44, to: 0.95, width: 0.085, inner: SIGNATURE.gold, outer: SIGNATURE.indigo },
    ],
    bursts: [
      { socket: 'grip.right', at: 0.62, count: 40, speed: 1.6, radius: 0.05, sparkRatio: 0.75 },
      { socket: 'grip.left', at: 0.72, count: 40, speed: 1.6, radius: 0.05, sparkRatio: 0.75 },
      { socket: 'grip.right', at: 0.79, count: 90, speed: 2.3, radius: 0.07, sparkRatio: 0.6 },
    ],
    aura: { from: 0.5, mid: 0.75, to: 0.95, peak: 0.4 },
    emissive: { from: 0.5, mid: 0.75, to: 0.95, peak: 1.2 },
    accent: { from: 0.5, mid: 0.75, to: 0.95, peak: 5 },
  },
  {
    id: 'phoenix-rise',
    name: 'Phoenix Rise',
    title: '鳳翔 · Phượng Tường',
    clip: 'preset:biped:flip',
    rate: 1.5,
    description: 'A leaping turn on trailing silk, and a lotus opening where she comes down.',
    // Measured: the feet peak at 7.81 and 8.73 m/s around t=0.45-0.48, and the crown stays in
    // motion from 0.275 to 0.658. The lotus opens just after the feet come back down.
    ribbons: [
      { socket: 'attachment.foot.right', from: 0.26, to: 0.62, width: 0.08 },
      { socket: 'effect.crown', from: 0.26, to: 0.68, width: 0.06, inner: SIGNATURE.gold, outer: SIGNATURE.crimson },
    ],
    emit: [{ socket: 'effect.pelvis', from: 0.3, to: 0.62, rate: 45, sparkRatio: 0.35 }],
    bursts: [{ socket: 'attachment.foot.left', at: 0.6, count: 110, speed: 1.9, radius: 0.13, sparkRatio: 0.4 }],
    lotus: { socket: 'attachment.foot.left', at: 0.6, scale: 1.7, duration: 2.2 },
    fractures: [{ socket: 'attachment.foot.left', at: 0.6, count: 2, radius: 0.9, duration: 0.8, spread: 0.7 }],
    flame: { from: 0.3, mid: 0.6, to: 0.95, peak: 0.7 },
    array: { socket: 'attachment.foot.left', at: 0.6, duration: 1.5, radius: 1.9 },
    aura: { from: 0.25, mid: 0.5, to: 0.85, peak: 0.45, colour: SIGNATURE.gold },
    emissive: { from: 0.25, mid: 0.5, to: 0.85, peak: 1.3 },
    accent: { from: 0.28, mid: 0.52, to: 0.85, peak: 5 },
  },
  {
    id: 'heaven-burn',
    name: 'Heaven Burn',
    title: '焚天裂空 · Phần Thiên Liệt Không',
    clip: 'preset:biped:jump_down',
    rate: 1.5,
    description: 'She comes down, the ground answers, the air splits open and the fire stands up around her.',
    // A drop and a landing, so the beats are simple: everything waits for the feet, then arrives at
    // once. The fractures are thrown in a scatter around the impact rather than from a single point,
    // because one crack reads as a decal and several read as an event.
    array: { socket: 'attachment.foot.left', at: 0.5, duration: 2.0, radius: 2.2 },
    fractures: [
      { socket: 'effect.pelvis', at: 0.5, count: 3, radius: 1.1, duration: 1.0, spread: 1.0 },
      { socket: 'effect.chest', at: 0.64, count: 2, radius: 0.75, duration: 0.9, spread: 1.3 },
    ],
    bursts: [
      { socket: 'attachment.foot.left', at: 0.5, count: 150, speed: 2.6, radius: 0.16, sparkRatio: 0.45 },
      { socket: 'effect.pelvis', at: 0.56, count: 80, speed: 1.8, radius: 0.2, sparkRatio: 0.3 },
    ],
    emit: [{ socket: 'effect.pelvis', from: 0.52, to: 0.95, rate: 70, sparkRatio: 0.5 }],
    flame: { from: 0.46, mid: 0.66, to: 1.0, peak: 1.0 },
    lotus: { socket: 'attachment.foot.left', at: 0.54, scale: 1.5, duration: 2.2 },
    aura: { from: 0.46, mid: 0.66, to: 0.95, peak: 0.7 },
    emissive: { from: 0.46, mid: 0.66, to: 0.95, peak: 2.0 },
    accent: { from: 0.46, mid: 0.66, to: 0.95, peak: 8 },
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
 * The persistent systems — the ink pool, the ribbons, the brush and the aura shell — are built once
 * and reused. Arrays, dragons, talismans and lotuses are created per cast because they are genuinely
 * one-shot, and are removed the frame they report they are finished, so a long session does not
 * accumulate objects.
 */
export class SkillDirector {
  readonly group = new THREE.Group();
  private readonly ink: InkBurst;
  private readonly slash: BrushSlash;
  private readonly ribbons = new Map<string, SilkRibbon>();
  private readonly aura: AuraShell;
  private readonly flame: SpiritFlame;
  private readonly transients: Effect[] = [];
  private active: SkillDefinition | null = null;
  private clipDuration = 0;
  private elapsed = 0;
  private readonly fired = new Set<string>();
  private readonly goldMaterial: THREE.MeshPhysicalMaterial | null;
  private readonly world = new THREE.Vector3();
  private readonly standOff = new THREE.Vector3();
  private readonly armOrigin = new THREE.Vector3();
  private readonly armDirection = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  /**
   * The pointing arm, fixed for the duration of one cast.
   *
   * Each cue used to measure the arm afresh, and the cast sweeps BOTH arms — so the seal, fired
   * early, chose the left hand while the dragon, fired later, chose the right, and the two effects
   * pointed opposite ways. Latching on first use keeps one cast pointing one way.
   */
  private armLatched = false;
  /** Called when a skill finishes on its own, so a caller's UI can stop showing it as active. */
  onRelease: (() => void) | null = null;

  constructor(
    private readonly character: TqCharacter,
    private readonly lights: StageLights,
  ) {
    this.group.name = 'tq:vfx';
    // Effects are not parts of the model: keep the container out of the parts inspector and the
    // explode layout, the same way each individual effect marks itself.
    this.group.userData.explodeWithParent = true;

    this.ink = new InkBurst({ count: 1600, seed: 0x7a11 });
    this.group.add(this.ink.object);

    this.slash = new BrushSlash({ samples: 44, width: 0.5 });
    this.group.add(this.slash.object);

    this.flame = new SpiritFlame({ count: 34, radius: 0.52, height: 1.35 });
    this.group.add(this.flame.object);

    // One ribbon per socket any skill trails from, built up front rather than per cast.
    const socketIds = new Set<string>();
    for (const skill of SKILLS) for (const ribbon of skill.ribbons ?? []) socketIds.add(ribbon.socket);
    for (const id of socketIds) {
      const ribbon = new SilkRibbon({ nodes: 40, length: 1.5 });
      this.ribbons.set(id, ribbon);
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

    // `restart` and `once`: an attack has to rewind when it is fired again, and hold its last pose
    // rather than looping back into its own wind-up.
    this.character.play(skill.clip, {
      fade: fadeSeconds,
      timeScale: skill.rate ?? 1,
      restart: true,
      loop: 'once',
    });
    this.active = skill;
    // The cue times are fractions of the clip, so the clock has to run on the clip's PLAYED
    // length; using its authored length would fire every cue late by the rate.
    this.clipDuration = clip.duration / (skill.rate ?? 1);
    this.elapsed = 0;
    this.fired.clear();
    this.armLatched = false;
    this.slash.clear();
    this.slash.opacity = 0;
    for (const ribbon of this.ribbons.values()) {
      ribbon.clear();
      ribbon.opacity = 0;
    }
    this.aura.setColour(skill.aura?.colour ?? SIGNATURE.crimson);
    return true;
  }

  /** Stop the skill's effects and return to an idle look. The clip is the caller's business. */
  release(): void {
    const wasActive = this.active !== null;
    this.active = null;
    this.ink.rate = 0;
    this.slash.opacity = 0;
    for (const ribbon of this.ribbons.values()) ribbon.opacity = 0;
    this.aura.strength = 0;
    this.flame.intensity = 0;
    this.lights.accent.intensity = 0;
    if (this.goldMaterial) this.goldMaterial.emissiveIntensity = 0;
    if (wasActive) this.onRelease?.();
  }

  /** World position of a socket right now, or null if the socket id is unknown. */
  private socketWorld(id: string): THREE.Vector3 | null {
    const node = this.character.sockets.get(id);
    if (!node) return null;
    node.getWorldPosition(this.world);
    return this.world;
  }

  /** Ground level under the figure, for anything that belongs on the floor. */
  private groundY(): number {
    return this.character.group.position.y;
  }

  /**
   * The arm that is currently pointing, and the direction it points in.
   *
   * Which arm leads is MEASURED rather than assumed: the clip sweeps both, so the pointing arm is
   * whichever hand has travelled furthest from the chest at the moment the cue fires. The direction
   * runs shoulder-to-hand, which is the line the audience reads as "she is aiming there" — a hand
   * position alone would not give an aim, only a point in space.
   *
   * Writes into `armOrigin` / `armDirection` and returns whether it found a usable pair.
   */
  private pointingArm(): boolean {
    if (this.armLatched) return true;
    const chest = this.character.sockets.get('effect.chest');
    if (!chest) return false;
    chest.getWorldPosition(this.scratch);

    let bestReach = -1;
    let found = false;
    for (const side of ['right', 'left'] as const) {
      const hand = this.character.sockets.get(`grip.${side}`);
      const shoulder = this.character.sockets.get(`effect.shoulder.${side}`);
      if (!hand || !shoulder) continue;
      const handAt = hand.getWorldPosition(new THREE.Vector3());
      const reach = handAt.distanceTo(this.scratch);
      if (reach <= bestReach) continue;
      const shoulderAt = shoulder.getWorldPosition(new THREE.Vector3());
      const direction = handAt.clone().sub(shoulderAt);
      if (direction.lengthSq() < 1e-8) continue;
      bestReach = reach;
      this.armOrigin.copy(handAt);
      this.armDirection.copy(direction).normalize();
      found = true;
    }
    this.armLatched = found;
    return found;
  }

  update(dt: number, camera: THREE.Camera): void {
    const skill = this.active;

    if (skill) {
      this.elapsed += dt;
      // Fraction through the clip. Skills run once and then release, so this is not wrapped.
      const t = this.clipDuration > 0 ? this.elapsed / this.clipDuration : 1;

      // --- 筆鋒 the stroke -----------------------------------------------------------------------
      if (skill.slash) {
        const at = this.socketWorld(skill.slash.socket);
        const on = t >= skill.slash.from && t <= skill.slash.to;
        if (at && on) {
          // `progress` runs the length of the stroke, so the ink is laid down as the arm travels.
          const progress = (t - skill.slash.from) / Math.max(1e-6, skill.slash.to - skill.slash.from);
          this.slash.push(at, camera.position, Math.min(1, progress * 1.25));
          this.slash.opacity = 1 - THREE.MathUtils.smoothstep(progress, 0.72, 1);
        } else {
          this.slash.opacity = Math.max(0, this.slash.opacity - dt * 3);
        }
      }

      // --- 綢帶 the ribbons ----------------------------------------------------------------------
      for (const spec of skill.ribbons ?? []) {
        const ribbon = this.ribbons.get(spec.socket);
        const at = this.socketWorld(spec.socket);
        if (!ribbon || !at) continue;
        const on = t >= spec.from && t <= spec.to;
        if (on) {
          // Seeded on the first frame of the window so the ribbon does not whip in from wherever
          // the last cast left it.
          if (t - spec.from < dt * 1.5) ribbon.reset(at);
          ribbon.follow(at, camera.position, dt);
          const span = Math.max(1e-6, (spec.to - spec.from) * 0.22);
          ribbon.opacity = Math.min(1, Math.min((t - spec.from) / span, (spec.to - t) / span));
        } else {
          ribbon.opacity = Math.max(0, ribbon.opacity - dt * 3);
        }
      }

      // --- 水墨 continuous emission --------------------------------------------------------------
      let emitting = false;
      for (const spec of skill.emit ?? []) {
        if (t >= spec.from && t <= spec.to) {
          const at = this.socketWorld(spec.socket);
          if (at) {
            this.ink.setAnchor(at);
            this.ink.rate = spec.rate;
            this.ink.sparkRatio = spec.sparkRatio ?? 0.45;
            emitting = true;
          }
        }
      }
      if (!emitting) this.ink.rate = 0;

      // --- 水墨 one-off bursts -------------------------------------------------------------------
      const bursts = skill.bursts ?? [];
      for (let i = 0; i < bursts.length; i += 1) {
        const burst = bursts[i];
        const key = `burst:${String(i)}`;
        if (t >= burst.at && !this.fired.has(key)) {
          const at = this.socketWorld(burst.socket);
          if (at) {
            this.ink.setAnchor(at);
            this.ink.sparkRatio = burst.sparkRatio ?? 0.45;
            this.ink.burst(burst.count, burst.speed ?? 1.4, burst.radius ?? 0.06);
          }
          this.fired.add(key);
        }
      }

      // --- 法陣 the array ------------------------------------------------------------------------
      if (skill.array && t >= skill.array.at && !this.fired.has('array')) {
        const at = this.socketWorld(skill.array.socket);
        if (at) {
          const array = new FormationArray(skill.array.duration, skill.array.radius);
          const orient = skill.array.orient ?? 'ground';
          if (orient === 'arm' && this.pointingArm()) {
            // Cast off the palm: the disc sits just beyond the hand with its NORMAL down the arm,
            // so it faces wherever she is pointing instead of always facing the camera.
            array.object.rotation.set(0, 0, 0);
            // Clear of the hand by slightly more than its own radius, so the disc sits in front of
            // the palm instead of engulfing the caster it was cast from.
            array.object.position.copy(this.armOrigin).addScaledVector(this.armDirection, skill.array.radius * 0.9);
            array.object.lookAt(this.scratch.copy(array.object.position).add(this.armDirection));
          } else if (orient === 'facing') {
            this.standOff.subVectors(at, camera.position);
            this.standOff.y = 0;
            const away = this.standOff.length();
            if (away > 1e-4) this.standOff.multiplyScalar(skill.array.radius * 0.55 / away);
            else this.standOff.set(0, 0, -1);
            array.object.rotation.set(0, 0, 0);
            array.object.position.copy(at).add(this.standOff);
            array.object.lookAt(camera.position);
          } else {
            // On the floor under the contact point, a hair above it to avoid z-fighting.
            array.object.position.set(at.x, this.groundY() + 0.012, at.z);
          }
          this.group.add(array.object);
          this.transients.push(array);
        }
        this.fired.add('array');
      }

      // --- 神龍 the dragon -----------------------------------------------------------------------
      if (skill.dragon && t >= skill.dragon.at && !this.fired.has('dragon')) {
        const at = this.socketWorld(skill.dragon.socket);
        if (at) {
          const dragon = new SpiritDragon(skill.dragon.duration, skill.dragon.height, skill.dragon.radius);
          if (skill.dragon.orient === 'arm' && this.pointingArm()) {
            // The helix is authored rising along +Y, so aiming it is one rotation: take +Y onto the
            // arm direction and the whole coil travels out of the palm along the line she points.
            dragon.object.position.copy(this.armOrigin);
            dragon.object.quaternion.setFromUnitVectors(this.scratch.set(0, 1, 0), this.armDirection);
          } else {
            // Coils from the floor up around the figure, not outward from the hip.
            dragon.object.position.set(at.x, this.groundY(), at.z);
          }
          this.group.add(dragon.object);
          this.transients.push(dragon);
        }
        this.fired.add('dragon');
      }

      // --- 符籙 the talismans --------------------------------------------------------------------
      if (skill.talismans && t >= skill.talismans.at && !this.fired.has('talismans')) {
        const at = this.socketWorld(skill.talismans.socket);
        if (at) {
          const swarm = new TalismanSwarm(at.clone(), skill.talismans.count, skill.talismans.duration);
          this.group.add(swarm.object);
          this.transients.push(swarm);
        }
        this.fired.add('talismans');
      }

      // --- 空間裂痕 the tears in the air ---------------------------------------------------------
      const fractures = skill.fractures ?? [];
      for (let i = 0; i < fractures.length; i += 1) {
        const spec = fractures[i];
        const key = `fracture:${String(i)}`;
        if (t >= spec.at && !this.fired.has(key)) {
          const at = this.socketWorld(spec.socket);
          if (at) {
            const spread = spec.spread ?? 0.6;
            for (let n = 0; n < spec.count; n += 1) {
              // Scattered around the socket on a deterministic spiral, so a burst of tears reads as
              // one event rather than as a stack of identical decals.
              const angle = (n / spec.count) * Math.PI * 2 + i * 1.7;
              const reach = spread * (0.35 + 0.65 * ((n * 7) % 5) / 5);
              const centre = new THREE.Vector3(
                at.x + Math.cos(angle) * reach,
                at.y + Math.sin(angle * 1.7) * spread * 0.5,
                at.z + Math.sin(angle) * reach * 0.6,
              );
              const tear = new AirFracture(
                centre,
                spec.radius * (0.65 + 0.35 * ((n * 3) % 4) / 3),
                spec.duration,
                i * 31 + n * 7.3,
              );
              tear.face(camera.position);
              this.group.add(tear.object);
              this.transients.push(tear);
            }
          }
          this.fired.add(key);
        }
      }

      // --- 蓮華 the lotus ------------------------------------------------------------------------
      if (skill.lotus && t >= skill.lotus.at && !this.fired.has('lotus')) {
        const at = this.socketWorld(skill.lotus.socket);
        if (at) {
          const lotus = new LotusBloom(
            new THREE.Vector3(at.x, this.groundY() + 0.02, at.z),
            skill.lotus.scale,
            skill.lotus.duration,
          );
          this.group.add(lotus.object);
          this.transients.push(lotus);
        }
        this.fired.add('lotus');
      }

      // --- envelopes -----------------------------------------------------------------------------
      this.aura.strength = skill.aura ? envelope(t, skill.aura.from, skill.aura.mid, skill.aura.to, skill.aura.peak) : 0;
      this.flame.intensity = skill.flame ? envelope(t, skill.flame.from, skill.flame.mid, skill.flame.to, skill.flame.peak) : 0;
      if (this.flame.intensity > 0.001) {
        // Stands on the floor beneath the figure, following her about the stage.
        const pelvis = this.socketWorld('effect.pelvis');
        if (pelvis) this.flame.setAnchor(this.scratch.set(pelvis.x, this.groundY(), pelvis.z));
      }
      this.lights.accent.intensity = skill.accent
        ? envelope(t, skill.accent.from, skill.accent.mid, skill.accent.to, skill.accent.peak)
        : 0;
      if (this.goldMaterial && skill.emissive) {
        this.goldMaterial.emissiveIntensity = envelope(t, skill.emissive.from, skill.emissive.mid, skill.emissive.to, skill.emissive.peak);
      }

      // The accent lamp follows the chest socket but STANDS OFF from it toward the viewer. Parked
      // on the socket it sits on the cuirass surface, and with `decay: 2` the irradiance a few
      // centimetres away is enormous — the armour went white while the skirt below stayed correct.
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

    this.ink.update(dt);
    this.slash.update();
    for (const ribbon of this.ribbons.values()) ribbon.update(dt);
    this.flame.update(dt);
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
    this.ink.dispose();
    this.slash.dispose();
    for (const ribbon of this.ribbons.values()) ribbon.dispose();
    this.flame.dispose();
    this.aura.dispose();
    for (const transient of this.transients) transient.dispose();
    this.transients.length = 0;
  }
}
