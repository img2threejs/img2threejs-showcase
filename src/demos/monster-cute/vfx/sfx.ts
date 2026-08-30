/**
 * The character's voice and effects, synthesised.
 *
 * HAND-WRITTEN, and deliberately **no audio files**. The whole point of this package is that a
 * model arrives as code with nothing fetched at runtime; shipping a folder of .wav files beside it
 * would break exactly the property that makes it interesting. So every sound here is built from
 * oscillators and envelopes at the moment it plays, which costs a few hundred bytes of source and
 * nothing on the wire.
 *
 * WHAT MAKES A SOUND READ AS CUTE, which is the whole design brief:
 *
 *   - **High and short.** Everything sits between roughly 400 Hz and 2 kHz and is over inside
 *     300 ms. Long or low reads as ominous however you shape it.
 *   - **Sine and triangle only.** No saw, no square. Those have the odd harmonics that make a
 *     sound read as harsh or mechanical; a cute sound is nearly a pure tone with a soft edge.
 *   - **Pitch bends upward.** A rising tail reads as pleased, a falling one as disappointed. The
 *     one sound that falls is `hurt`, and it falls for exactly that reason.
 *   - **A major pentatonic scale.** Every pitched sound is snapped to it, so two effects landing
 *     on the same frame can never be dissonant — which is what stops a busy moment turning ugly.
 *   - **No attack transient.** Each note ramps in over ~8 ms rather than starting instantly. An
 *     instant start is a click, and a click is the least cute sound there is.
 *
 * Autoplay: browsers refuse to start audio without a user gesture, so the context is created
 * suspended and resumed on the first click or key. Nothing plays before that, whatever is enabled.
 */

/** Major pentatonic on C, five octaves. Nothing outside this set is ever played. */
const PENTATONIC = [0, 2, 4, 7, 9];
const BASE_HZ = 261.63; // middle C

function scaleNote(step: number): number {
  const octave = Math.floor(step / PENTATONIC.length);
  const degree = PENTATONIC[((step % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length];
  return BASE_HZ * 2 ** (octave + degree / 12);
}

export type SoundName =
  | 'step' | 'land' | 'cast' | 'blast' | 'slam' | 'hurt' | 'sparkle' | 'heart' | 'switch' | 'arc';

export class Sfx {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;
  private unlocked = false;
  /** Rate limit per sound, so a fast clip cannot machine-gun one effect. */
  private readonly lastAt = new Map<SoundName, number>();
  private voices = 0;

  constructor(private readonly volume = 0.32) {}

  /**
   * Create the context. Safe to call repeatedly; only the first call does anything.
   *
   * Called from a real user gesture — a browser will create a suspended context at any time but
   * will not let it make a sound until one has happened.
   */
  unlock(): void {
    if (this.unlocked) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    // A gentle ceiling. Several effects can land on one frame, and without this their gains simply
    // add and clip.
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(this.context.destination);
    this.unlocked = true;
    void this.context.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(on ? this.volume : 0, this.context.currentTime, 0.02);
    }
    if (on) void this.context?.resume();
  }

  get isEnabled(): boolean { return this.enabled; }
  get isUnlocked(): boolean { return this.unlocked; }
  /** 'running' is the only state that actually makes a sound; 'suspended' means the gesture has
   * not landed yet, and 'closed' means disposed. */
  get state(): string { return this.context?.state ?? 'none'; }
  /** How many voices have been started. Proves the graph is being driven, which "unlocked" does not. */
  get voicesStarted(): number { return this.voices; }

  /**
   * One pitched voice: an oscillator with a soft envelope and an optional pitch bend.
   *
   * `attack` is never zero. A gain that jumps straight to full is a click, and no amount of
   * choosing a nice frequency rescues a sound that starts with a click.
   */
  private voice(o: {
    freq: number; dur: number; type?: OscillatorType; gain?: number;
    bendTo?: number; attack?: number; delay?: number; detune?: number;
  }): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const attack = o.attack ?? 0.008;
    const peak = o.gain ?? 0.5;

    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.bendTo !== undefined) {
      // Exponential, not linear: pitch is perceived logarithmically, so a linear ramp sounds like
      // it slows down as it rises.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.bendTo), t0 + o.dur);
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.02);
    this.voices += 1;
  }

  /** Filtered noise: the body of a footstep or a thump, where a tone alone sounds like a doorbell. */
  private noise(o: { dur: number; gain?: number; freq?: number; q?: number; delay?: number; sweepTo?: number }): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const frames = Math.max(1, Math.floor(ctx.sampleRate * o.dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Band-passed and swept downward: an unfiltered burst is a hiss, and a hiss is never cute.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(o.freq ?? 900, t0);
    if (o.sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.sweepTo), t0 + o.dur);
    filter.Q.value = o.q ?? 1.1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(o.gain ?? 0.25, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    source.connect(filter).connect(gain).connect(master);
    source.start(t0);
    source.stop(t0 + o.dur + 0.02);
    this.voices += 1;
  }

  /**
   * Play one of the character's sounds.
   *
   * `strength` 0..1 scales loudness and, on the sounds where it makes sense, pitch — a soft
   * footfall is quieter AND higher than a heavy one, which is most of what makes a run read as
   * light rather than as the same sample repeated.
   */
  play(name: SoundName, strength = 1): void {
    if (!this.enabled || !this.context || !this.master) return;

    // Rate limit. Without it a dash fires a footstep every other frame and the result is a buzz.
    const now = this.context.currentTime;
    const minGap: Partial<Record<SoundName, number>> = { step: 0.11, arc: 0.5, land: 0.12, switch: 0.15 };
    const gap = minGap[name];
    if (gap !== undefined && now - (this.lastAt.get(name) ?? -Infinity) < gap) return;
    this.lastAt.set(name, now);

    const s = Math.max(0, Math.min(1, strength));

    switch (name) {
      case 'step': {
        // A soft paw, not a boot: a short filtered thump with a tiny tone under it. Pitch rises as
        // the step gets lighter.
        this.noise({ dur: 0.075, gain: 0.1 + 0.14 * s, freq: 620 + 260 * (1 - s), sweepTo: 220, q: 0.9 });
        this.voice({ freq: scaleNote(4 + Math.round(s)), dur: 0.06, type: 'sine', gain: 0.05 + 0.05 * s, bendTo: scaleNote(2) });
        break;
      }
      case 'land': {
        this.noise({ dur: 0.16, gain: 0.18 + 0.2 * s, freq: 420, sweepTo: 140, q: 0.8 });
        // The little upward "boing" after the thump is the whole character of the sound.
        this.voice({ freq: scaleNote(2), dur: 0.13, type: 'triangle', gain: 0.16 * s, bendTo: scaleNote(7), delay: 0.03 });
        break;
      }
      case 'cast': {
        // A rising four-note arpeggio. Rising = gathering.
        for (let i = 0; i < 4; i += 1) {
          this.voice({ freq: scaleNote(7 + i), dur: 0.2, type: 'sine', gain: 0.2, delay: i * 0.055, bendTo: scaleNote(8 + i) });
        }
        this.voice({ freq: scaleNote(12), dur: 0.5, type: 'triangle', gain: 0.1, delay: 0.2 });
        break;
      }
      case 'blast': {
        // A "pew": bright, falling fast, with a breath of noise for the body.
        this.voice({ freq: scaleNote(14), dur: 0.16, type: 'triangle', gain: 0.26, bendTo: scaleNote(6) });
        this.noise({ dur: 0.12, gain: 0.1, freq: 1800, sweepTo: 500, q: 1.4 });
        break;
      }
      case 'slam': {
        this.noise({ dur: 0.22, gain: 0.3, freq: 300, sweepTo: 90, q: 0.7 });
        this.voice({ freq: scaleNote(0), dur: 0.22, type: 'sine', gain: 0.2, bendTo: scaleNote(-3) });
        // Sparkle on top, so it lands as bright rather than heavy.
        for (let i = 0; i < 3; i += 1) {
          this.voice({ freq: scaleNote(12 + i * 2), dur: 0.24, type: 'sine', gain: 0.08, delay: 0.05 + i * 0.03 });
        }
        break;
      }
      case 'hurt': {
        // The one falling sound in the set. Two notes down, soft, more startled than pained.
        this.voice({ freq: scaleNote(9), dur: 0.13, type: 'triangle', gain: 0.22, bendTo: scaleNote(6) });
        this.voice({ freq: scaleNote(6), dur: 0.22, type: 'sine', gain: 0.18, bendTo: scaleNote(3), delay: 0.1 });
        break;
      }
      case 'sparkle': {
        // Bell-ish: random pentatonic notes high up, each a touch detuned so they shimmer.
        for (let i = 0; i < 5; i += 1) {
          const step = 12 + Math.floor(Math.random() * 6);
          this.voice({ freq: scaleNote(step), dur: 0.34, type: 'sine', gain: 0.12, delay: i * 0.045, detune: (Math.random() - 0.5) * 14 });
        }
        break;
      }
      case 'heart': {
        // Two notes up a fourth — the most unambiguously happy interval there is.
        this.voice({ freq: scaleNote(9), dur: 0.16, type: 'sine', gain: 0.18 });
        this.voice({ freq: scaleNote(12), dur: 0.24, type: 'sine', gain: 0.16, delay: 0.1 });
        break;
      }
      case 'switch': {
        // Punctuation for a clip change. Barely there on purpose.
        this.voice({ freq: scaleNote(10), dur: 0.09, type: 'sine', gain: 0.1, bendTo: scaleNote(12) });
        break;
      }
      case 'arc': {
        // The horn arc: a shimmer, not a crackle. Two detuned voices beating against each other.
        this.voice({ freq: scaleNote(16), dur: 0.4, type: 'sine', gain: 0.07, detune: 8 });
        this.voice({ freq: scaleNote(16), dur: 0.4, type: 'sine', gain: 0.07, detune: -9 });
        break;
      }
    }
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.unlocked = false;
  }
}
