import type { GameEvent } from '../game/game';

/**
 * Every sound in NULLRUN is synthesised here at runtime.
 *
 * The game had no audio at all, which meant the most dramatic thing that can
 * happen to you — being seen — registered as a number going up. Nothing here
 * loads a file: it is all oscillators and filtered noise, so the whole sound
 * design costs one module and no network requests, and it still ships on a
 * static host.
 *
 * Browsers refuse to start an AudioContext before the user interacts with the
 * page, so the context is created lazily on the first sound after a gesture.
 */

const STORAGE_KEY = 'nullrun.audio.v1';

export class AudioKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Raised while the facility is hot, so the mix gets tighter under pressure. */
  private tension = 0;
  enabled: boolean;

  constructor() {
    this.enabled = this.loadPreference();
  }

  private loadPreference(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      /* a missing storage API must not cost you sound */
    }
    if (!on) this.master?.gain.setTargetAtTime(0, this.now, 0.02);
    else this.master?.gain.setTargetAtTime(0.9, this.now, 0.02);
  }

  /** How hot the facility is, 0-1. Higher means harsher stings. */
  setTension(value: number): void {
    this.tension = Math.max(0, Math.min(1, value));
  }

  private get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Build the graph on first use — before a gesture this is a no-op. */
  private ensure(): boolean {
    if (!this.enabled) return false;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      try {
        this.ctx = new Ctor();
      } catch {
        return false;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);

      // one second of white noise, reused by every percussive sound
      const frames = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return true;
  }

  // -- primitives ----------------------------------------------------------

  /** A pitched blip. Sweeping from -> to gives sirens, stabs and power-downs. */
  private tone(opts: {
    from: number;
    to?: number;
    type?: OscillatorType;
    gain?: number;
    attack?: number;
    duration: number;
    delay?: number;
    detune?: number;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const start = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.from, start);
    if (opts.to !== undefined && opts.to !== opts.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), start + opts.duration);
    }
    if (opts.detune) osc.detune.value = opts.detune;

    const gain = ctx.createGain();
    const peak = opts.gain ?? 0.2;
    const attack = opts.attack ?? 0.006;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration);

    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + opts.duration + 0.05);
  }

  /** A burst of filtered noise — footsteps, impacts, mechanical clacks. */
  private hit(opts: {
    frequency: number;
    q?: number;
    gain?: number;
    duration: number;
    delay?: number;
    type?: BiquadFilterType;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;

    const start = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.value = opts.frequency;
    filter.Q.value = opts.q ?? 1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain ?? 0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration);

    src.connect(filter).connect(gain).connect(master);
    src.start(start);
    src.stop(start + opts.duration + 0.02);
  }

  // -- the kit -------------------------------------------------------------

  play(event: GameEvent): void {
    if (!this.ensure()) return;
    const heat = this.tension;

    switch (event) {
      case 'step':
        this.hit({ frequency: 1600, q: 0.7, gain: 0.045, duration: 0.05 });
        break;

      case 'sprint':
        this.hit({ frequency: 900, q: 0.5, gain: 0.13, duration: 0.28 });
        this.tone({ from: 320, to: 140, type: 'triangle', gain: 0.07, duration: 0.24 });
        break;

      case 'hack':
        // a little data chatter, rising so it reads as success
        this.tone({ from: 780, type: 'square', gain: 0.05, duration: 0.06 });
        this.tone({ from: 1040, type: 'square', gain: 0.05, duration: 0.06, delay: 0.07 });
        this.tone({ from: 1560, type: 'square', gain: 0.06, duration: 0.1, delay: 0.14 });
        break;

      case 'grab':
        this.tone({ from: 1180, to: 1760, type: 'triangle', gain: 0.11, duration: 0.16 });
        break;

      case 'door':
        this.hit({ frequency: 320, q: 1.4, gain: 0.16, duration: 0.12 });
        this.tone({ from: 90, to: 60, gain: 0.11, duration: 0.16 });
        break;

      case 'near_miss':
        // two low thumps: a heartbeat, felt more than heard
        this.tone({ from: 62, to: 44, gain: 0.22, attack: 0.012, duration: 0.2 });
        this.tone({ from: 55, to: 38, gain: 0.15, attack: 0.012, duration: 0.24, delay: 0.3 });
        break;

      case 'spotted': {
        // the sting: a hard dissonant stab over a falling boom. This is the
        // sound the whole feature exists for, so it is allowed to be loud.
        this.tone({ from: 880, to: 440, type: 'sawtooth', gain: 0.2, attack: 0.004, duration: 0.5 });
        this.tone({
          from: 932,
          to: 466,
          type: 'sawtooth',
          gain: 0.16,
          attack: 0.004,
          duration: 0.5,
          detune: 18,
        });
        this.tone({ from: 150, to: 48, gain: 0.3, attack: 0.004, duration: 0.7 });
        this.hit({ frequency: 2600, q: 0.6, gain: 0.12 + heat * 0.1, duration: 0.18 });
        break;
      }

      case 'takedown':
        this.hit({ frequency: 260, q: 1.1, gain: 0.24, duration: 0.16 });
        this.tone({ from: 120, to: 52, gain: 0.2, duration: 0.26 });
        break;

      case 'body_found':
        this.tone({ from: 620, to: 880, type: 'square', gain: 0.14, duration: 0.22 });
        this.tone({ from: 620, to: 880, type: 'square', gain: 0.14, duration: 0.22, delay: 0.26 });
        break;

      case 'escalate':
        // three rising steps: the building tightening around you
        this.tone({ from: 300, type: 'sawtooth', gain: 0.1, duration: 0.16 });
        this.tone({ from: 400, type: 'sawtooth', gain: 0.11, duration: 0.16, delay: 0.17 });
        this.tone({ from: 520, type: 'sawtooth', gain: 0.13, duration: 0.34, delay: 0.34 });
        break;

      case 'lockdown':
        // a two-tone siren that sinks instead of resolving
        for (let i = 0; i < 3; i++) {
          this.tone({
            from: 700,
            to: 420,
            type: 'sawtooth',
            gain: 0.16,
            duration: 0.4,
            delay: i * 0.42,
          });
        }
        this.tone({ from: 90, to: 40, gain: 0.26, duration: 1.4 });
        break;

      case 'blackout':
        // the sound of a building losing its power
        this.tone({ from: 460, to: 40, type: 'triangle', gain: 0.18, duration: 0.9 });
        break;

      case 'floor_clear': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((note, i) =>
          this.tone({ from: note, type: 'triangle', gain: 0.13, duration: 0.3, delay: i * 0.09 }),
        );
        break;
      }

      case 'run_failed':
        this.tone({ from: 220, to: 55, type: 'sawtooth', gain: 0.2, duration: 1.3 });
        this.tone({ from: 110, to: 34, gain: 0.26, duration: 1.6 });
        break;
    }
  }
}
