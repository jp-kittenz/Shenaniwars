import { clamp } from '../core/math.js';

const MAX_VOICES = 14;

/**
 * Fully procedural WebAudio sound: no assets to download or decode. Voices
 * are budgeted (oldest-first rejection by loudness) and every one-shot shares
 * a single pre-rendered noise buffer, so a firefight allocates only the
 * handful of short-lived graph nodes WebAudio requires per voice.
 */
export class AudioSystem {
  /** @param {import('../core/event-bus.js').EventBus} bus */
  constructor(bus) {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    this._voices = 0;
    this.muted = false;
    bus.on('sound', (kind, x, y, z) => this.play(kind, x, y, z));
  }

  /** Must be called from a user gesture (autoplay policy). */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      // Persistent engine voice (silent until the player boards something).
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 400;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
      this.engineOsc.start();
    } catch (err) {
      console.warn('[audio] unavailable', err);
      this.ctx = null;
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
  }

  /** @param {number} x @param {number} y @param {number} z @param {number} yaw listener heading */
  setListener(x, y, z, yaw) {
    const l = this.listener;
    l.x = x; l.y = y; l.z = z; l.rx = -Math.cos(yaw); l.rz = Math.sin(yaw);
  }

  /** @param {number} level 0..1 loudness @param {number} pitch Hz @param {boolean} rotor */
  setEngine(level, pitch, rotor = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(level * 0.11, t, 0.15);
    this.engineOsc.frequency.setTargetAtTime(pitch, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(rotor ? 260 : 520, t, 0.2);
  }

  /**
   * @param {string} kind
   * @param {number} [x] omit coordinates for a non-positional UI sound
   */
  play(kind, x, y, z) {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    let gain = 1, pan = 0;
    if (x !== undefined) {
      const l = this.listener;
      const dx = x - l.x, dy = /** @type {number} */ (y) - l.y, dz = /** @type {number} */ (z) - l.z;
      const d = Math.hypot(dx, dy, dz);
      const ref = kind === 'explosion' || kind === 'cannon' ? 45 : 18;
      gain = 1 / (1 + (d / ref) * (d / ref));
      if (gain < 0.012) return;
      pan = d > 0.5 ? clamp((dx * l.rx + dz * l.rz) / d, -1, 1) * 0.8 : 0;
    }
    if (this._voices >= MAX_VOICES && gain < 0.5) return;

    const t = ctx.currentTime;
    const out = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) { panner.pan.value = pan; out.connect(panner).connect(this.master); } else out.connect(this.master);
    let dur = 0.2;

    const noise = (freq, type, q, attackGain, decay, sweepTo) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(attackGain * gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      src.connect(f).connect(g).connect(out);
      src.start(t, Math.random() * 0.5);
      src.stop(t + decay + 0.02);
      src.onended = () => { this._voices--; out.disconnect(); if (panner) panner.disconnect(); };
      this._voices++;
      dur = Math.max(dur, decay);
    };
    const tone = (type, f0, f1, attackGain, decay) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(attackGain * gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    };

    switch (kind) {
      case 'shot': noise(1900, 'bandpass', 0.8, 0.9, 0.11, 700); tone('square', 170, 55, 0.25, 0.07); break;
      case 'shotAK': noise(1500, 'bandpass', 0.7, 1.0, 0.14, 520); tone('square', 140, 46, 0.32, 0.09); break;
      case 'autocannon': noise(800, 'bandpass', 0.6, 1.1, 0.2, 260); tone('square', 95, 38, 0.45, 0.12); break;
      case 'missile': noise(1200, 'bandpass', 1.4, 0.7, 0.9, 3200); tone('sawtooth', 260, 520, 0.12, 0.6); break;
      case 'release': noise(400, 'lowpass', 0.6, 0.4, 0.25, 120); break;
      case 'lock': tone('square', 1320, 1320, 0.12, 0.08); break;
      case 'shotHeavy': noise(1100, 'bandpass', 0.7, 1.0, 0.16, 380); tone('square', 120, 42, 0.35, 0.1); break;
      case 'rocket': noise(700, 'bandpass', 1.2, 0.8, 0.55, 2400); break;
      case 'cannon': noise(900, 'lowpass', 0.5, 1.6, 0.7, 90); tone('sine', 95, 28, 1.2, 0.5); break;
      case 'explosion': noise(1200, 'lowpass', 0.4, 1.7, 1.1, 60); tone('sine', 80, 24, 1.1, 0.7); break;
      case 'hit': tone('triangle', 1500, 900, 0.22, 0.05); noise(3000, 'highpass', 0.5, 0.0001, 0.05); break;
      case 'kill': tone('triangle', 700, 1400, 0.3, 0.14); noise(3000, 'highpass', 0.5, 0.0001, 0.14); break;
      case 'reload': noise(2600, 'bandpass', 3, 0.35, 0.05); break;
      case 'capture': tone('sine', 520, 1040, 0.3, 0.4); noise(3000, 'highpass', 0.5, 0.0001, 0.4); break;
      case 'glass': noise(5200, 'highpass', 0.8, 0.5, 0.35, 2400); tone('triangle', 2600, 1900, 0.06, 0.12); break;
      case 'whistle': tone('sine', 1500, 420, 0.07, 0.9); break;
      default: noise(1500, 'bandpass', 1, 0.4, 0.1);
    }
  }
}
