// ============================================================
// Voxelcraft — procedural sound engine (WebAudio, fully
// synthesized — no samples). Original composition.
// ============================================================

type SfxFamily = 'grass' | 'stone' | 'wood' | 'sand' | 'glass' | 'snow' | 'wool' | 'liquid' | 'plant';

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private busBlocks: GainNode | null = null;
  private busMusic: GainNode | null = null;
  private busAmbient: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private musicTimer: number | null = null;
  private lastStep = 0;
  volumes = { master: 1, music: 0.6, blocks: 1, ambient: 1 };

  ensure(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
    } catch { return; }
    const c = this.ctx;
    this.masterGain = c.createGain();
    this.masterGain.connect(c.destination);
    this.busBlocks = c.createGain(); this.busBlocks.connect(this.masterGain);
    this.busMusic = c.createGain(); this.busMusic.connect(this.masterGain);
    this.busAmbient = c.createGain(); this.busAmbient.connect(this.masterGain);
    this.applyVolumes();
    // white noise buffer
    const len = c.sampleRate * 1;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startMusicLoop();
  }

  applyVolumes(): void {
    if (!this.masterGain) return;
    this.masterGain.gain.value = this.volumes.master;
    this.busBlocks!.gain.value = this.volumes.blocks;
    this.busMusic!.gain.value = this.volumes.music * 0.5;
    this.busAmbient!.gain.value = this.volumes.ambient * 0.6;
  }

  setVolumes(master: number, music: number, blocks: number, ambient: number): void {
    this.volumes = { master: master / 100, music: music / 100, blocks: blocks / 100, ambient: ambient / 100 };
    this.applyVolumes();
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number, bus: GainNode, sweepTo?: number): void {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(); src.stop(c.currentTime + dur + 0.02);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType, bus: GainNode, slideTo?: number, delay = 0): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    const t0 = c.currentTime + delay;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(bus);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  dig(family: SfxFamily, pitch = 1): void {
    if (!this.ctx || !this.busBlocks) return;
    const v = 0.5;
    switch (family) {
      case 'grass': case 'plant':
        this.noise(0.09, 'lowpass', 900 * pitch, 1, v, this.busBlocks); break;
      case 'stone':
        this.noise(0.075, 'bandpass', 520 * pitch, 1.6, v * 0.9, this.busBlocks);
        this.noise(0.05, 'highpass', 1800, 1, v * 0.25, this.busBlocks); break;
      case 'wood':
        this.noise(0.08, 'bandpass', 380 * pitch, 2.2, v, this.busBlocks);
        this.tone(160 * pitch, 0.06, v * 0.25, 'triangle', this.busBlocks); break;
      case 'sand':
        this.noise(0.12, 'highpass', 900, 0.8, v * 0.55, this.busBlocks); break;
      case 'glass':
        this.tone(1400 * pitch, 0.1, v * 0.3, 'sine', this.busBlocks, 900 * pitch);
        this.noise(0.08, 'highpass', 3000, 1, v * 0.4, this.busBlocks); break;
      case 'snow':
        this.noise(0.1, 'lowpass', 1400, 0.7, v * 0.7, this.busBlocks); break;
      case 'wool':
        this.noise(0.09, 'lowpass', 600, 0.8, v * 0.6, this.busBlocks); break;
      case 'liquid':
        this.noise(0.15, 'lowpass', 700 * pitch, 1, v * 0.5, this.busBlocks, 300); break;
    }
  }

  breakBlock(family: SfxFamily): void {
    this.dig(family, 0.85);
    if (!this.ctx || !this.busBlocks) return;
    this.noise(0.18, 'lowpass', 500, 1, 0.4, this.busBlocks, 140);
  }

  place(family: SfxFamily): void {
    this.dig(family, 1.15);
  }

  step(family: SfxFamily): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastStep < 0.22) return;
    this.lastStep = now;
    if (!this.busBlocks) return;
    const v = 0.14;
    switch (family) {
      case 'grass': case 'plant': this.noise(0.07, 'lowpass', 800, 1, v, this.busBlocks); break;
      case 'stone': this.noise(0.06, 'bandpass', 480, 1.8, v, this.busBlocks); break;
      case 'wood': this.noise(0.06, 'bandpass', 340, 2.4, v, this.busBlocks); break;
      case 'sand': this.noise(0.09, 'highpass', 1100, 0.7, v * 0.8, this.busBlocks); break;
      case 'glass': this.noise(0.05, 'highpass', 2600, 1, v * 0.5, this.busBlocks); break;
      case 'snow': this.noise(0.08, 'lowpass', 1300, 0.7, v, this.busBlocks); break;
      case 'wool': this.noise(0.07, 'lowpass', 500, 0.8, v, this.busBlocks); break;
      default: this.noise(0.07, 'lowpass', 700, 1, v, this.busBlocks);
    }
  }

  splash(): void {
    if (!this.busBlocks) return;
    this.noise(0.4, 'lowpass', 1500, 0.8, 0.5, this.busBlocks, 250);
    this.noise(0.25, 'highpass', 800, 0.7, 0.3, this.busBlocks);
  }

  hurt(): void {
    if (!this.busBlocks) return;
    this.tone(340, 0.16, 0.35, 'sawtooth', this.busBlocks, 180);
    this.noise(0.12, 'lowpass', 800, 1, 0.25, this.busBlocks);
  }

  pop(): void {
    if (!this.busBlocks) return;
    this.tone(660, 0.06, 0.2, 'sine', this.busBlocks, 880);
  }

  click(): void {
    if (!this.ctx || !this.busBlocks) return;
    this.tone(520, 0.045, 0.18, 'square', this.busBlocks, 420);
  }

  caveDrone(): void {
    if (!this.busAmbient || !this.ctx) return;
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = 55 + Math.random() * 30;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, c.currentTime + 2.5);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 7);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.4;
    const lg = c.createGain(); lg.gain.value = 8;
    lfo.connect(lg); lg.connect(o.frequency);
    o.connect(g); g.connect(this.busAmbient);
    o.start(); lfo.start();
    o.stop(c.currentTime + 7.2); lfo.stop(c.currentTime + 7.2);
  }

  // ---------------- weather ----------------

  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;

  /** continuous rain loop; level 0..1 (0 = off) */
  setRain(level: number): void {
    if (!this.ctx || !this.busAmbient) return;
    if (level <= 0) {
      if (this.rainGain) {
        this.rainGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.6);
      }
      return;
    }
    if (!this.rainSrc) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.4;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 350;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0.0001;
      src.connect(lp); lp.connect(hp); hp.connect(this.rainGain); this.rainGain.connect(this.busAmbient);
      src.start();
      this.rainSrc = src;
    }
    this.rainGain?.gain.setTargetAtTime(0.10 + 0.10 * level, this.ctx.currentTime, 1.2);
  }

  thunder(): void {
    if (!this.ctx || !this.busAmbient || !this.noiseBuf) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, c.currentTime);
    lp.frequency.exponentialRampToValueAtTime(70, c.currentTime + 1.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.55, c.currentTime + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.9);
    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(58, c.currentTime);
    sub.frequency.exponentialRampToValueAtTime(32, c.currentTime + 1.4);
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.0001, c.currentTime);
    sg.gain.exponentialRampToValueAtTime(0.3, c.currentTime + 0.08);
    sg.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.6);
    src.connect(lp); lp.connect(g); g.connect(this.busAmbient);
    sub.connect(sg); sg.connect(this.busAmbient);
    src.start(); sub.start();
    src.stop(c.currentTime + 2); sub.stop(c.currentTime + 1.7);
  }

  // Generative calm music: slow pentatonic pad chords + sparse melody.
  private startMusicLoop(): void {
    const schedule = () => {
      if (this.ctx && this.busMusic) this.musicPhrase();
      this.musicTimer = window.setTimeout(schedule, 9000 + Math.random() * 9000);
    };
    this.musicTimer = window.setTimeout(schedule, 2500);
  }

  private musicPhrase(): void {
    if (!this.ctx || !this.busMusic) return;
    const c = this.ctx;
    // pentatonic over root chosen from a calm set
    const roots = [220, 246.9, 196, 174.6];
    const root = roots[(Math.random() * roots.length) | 0];
    const ratios = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]; // major pentatonic-ish
    const chordN = 3;
    for (let i = 0; i < chordN; i++) {
      const f = root * ratios[(Math.random() * ratios.length) | 0] * (Math.random() < 0.4 ? 2 : 1);
      this.pad(f, 5 + Math.random() * 4, 0.055);
    }
    // sparse melody
    const notes = 2 + ((Math.random() * 3) | 0);
    let t = 1.2;
    for (let i = 0; i < notes; i++) {
      const f = root * 2 * ratios[(Math.random() * ratios.length) | 0];
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = c.createGain();
      const t0 = c.currentTime + t;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
      const dl = c.createDelay(); dl.delayTime.value = 0.31;
      const fb = c.createGain(); fb.gain.value = 0.35;
      const wet = c.createGain(); wet.gain.value = 0.4;
      o.connect(g); g.connect(this.busMusic);
      g.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(this.busMusic);
      o.start(t0); o.stop(t0 + 1.8);
      t += 0.9 + Math.random() * 1.4;
    }
  }

  private pad(freq: number, dur: number, gain: number): void {
    const c = this.ctx!;
    const t0 = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const o2 = c.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 1.005; // slow beat
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 2.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    o.connect(g); o2.connect(g); g.connect(lp); lp.connect(this.busMusic!);
    o.start(t0); o2.start(t0);
    o.stop(t0 + dur + 0.1); o2.stop(t0 + dur + 0.1);
  }

  dispose(): void {
    if (this.musicTimer) { clearTimeout(this.musicTimer); this.musicTimer = null; }
    if (this.rainSrc) { try { this.rainSrc.stop(); } catch { /* already stopped */ } this.rainSrc = null; this.rainGain = null; }
    if (this.ctx) { void this.ctx.close(); this.ctx = null; }
  }
}
