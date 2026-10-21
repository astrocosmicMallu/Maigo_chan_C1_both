/* ============================================================================
   audio.js — native Web Audio API engine (zero audio files)
   ----------------------------------------------------------------------------
   • Layered Tokyo-alley ambience: rumble, rain hiss, distant traffic, vending
     machine compressors, sodium-lamp buzz, heartbeat and tension drone.
   • A tremulous child voice built from a glottal saw source + Japanese vowel
     formant filters, jittered f0 and a 5.6 Hz vocal tremor.
   • Jumpscare chain: distorted scream cluster + sub-bass drop + hard limiter.
   ========================================================================== */

const now = (ctx) => ctx.currentTime;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.ambientMuted = false;
    this.ambientLevel = 0.7;
    this.dread = 0;
    this.events = { traffic: 8, creak: 20, heart: 0, hum: 0 };
    this._humTarget = 0;
    this._tensionTarget = 0;
    this._muted = false;
  }

  /* ------------------------------------------------------------------ */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // master: compressor -> soft clip -> destination
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.28;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;

    this.master = ctx.createGain();
    this.master.gain.value = 0.82;
    this.master.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.ambientLevel;
    this.ambientBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 2.2;

    // de-esser + click guard: a soft knee compressor and a high shelf cut.
    // Raw formant synthesis has a lot of energy at 6–9 kHz, which is exactly
    // where cheap speakers and laptop DACs start to crackle.
    this.voiceDeEss = ctx.createBiquadFilter();
    this.voiceDeEss.type = 'highshelf';
    this.voiceDeEss.frequency.value = 6200;
    this.voiceDeEss.gain.value = -9;

    this.voiceComp = ctx.createDynamicsCompressor();
    this.voiceComp.threshold.value = -20;
    this.voiceComp.knee.value = 24;
    this.voiceComp.ratio.value = 3.2;
    this.voiceComp.attack.value = 0.006;
    this.voiceComp.release.value = 0.22;

    this.voiceBus.connect(this.voiceDeEss);
    this.voiceDeEss.connect(this.voiceComp);
    this.voiceComp.connect(this.master);

    // shared reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.4);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.34;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    // the voice gets only a light room send, otherwise consonants smear
    this.voiceSend = ctx.createGain();
    this.voiceSend.gain.value = 0.5;
    this.voiceSend.connect(this.reverb);

    this.noiseBuf = this.makeNoise(2.0, false);
    this.brownBuf = this.makeNoise(3.0, true);

    this.startAmbience();
    this.ready = true;
    this.preloadVoice();          // fire and forget; the lines are ~50 KB each
    // the scream may have been fetched before there was a context to decode it
    if (this._slamRaw) {
      this.ctx.decodeAudioData(this._slamRaw.slice(0))
        .then((buf) => { this.slamBuf = buf; })
        .catch(() => { this.slamBuf = null; });
      this._slamRaw = null;
    } else {
      this.preloadSlam();
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /* ---------------------------- buffers ----------------------------- */
  makeNoise(seconds = 2, brown = false) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        if (brown) {
          last = (last + 0.02 * white) / 1.02;
          d[i] = last * 3.5;
        } else {
          d[i] = white;
        }
      }
    }
    return buf;
  }

  makeImpulse(seconds = 2.4, decay = 2.6) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 60 ? i / 60 : 1);
      }
    }
    return buf;
  }

  /* --------------------------- ambience ----------------------------- */
  startAmbience() {
    const ctx = this.ctx;
    const t = now(ctx);

    // deep city rumble
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.brownBuf;
    rumble.loop = true;
    const rumbleLP = ctx.createBiquadFilter();
    rumbleLP.type = 'lowpass';
    rumbleLP.frequency.value = 110;
    rumbleLP.Q.value = 0.6;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.16;
    rumble.connect(rumbleLP); rumbleLP.connect(this.rumbleGain); this.rumbleGain.connect(this.ambientBus);
    rumble.start(t);

    // rain / air hiss
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuf;
    air.loop = true;
    const airBP = ctx.createBiquadFilter();
    airBP.type = 'bandpass';
    airBP.frequency.value = 1400;
    airBP.Q.value = 0.35;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0.022;
    air.connect(airBP); airBP.connect(this.airGain); this.airGain.connect(this.ambientBus);
    air.start(t);

    // sodium lamp electrical buzz
    const buzz = ctx.createOscillator();
    buzz.type = 'sawtooth';
    buzz.frequency.value = 100;
    const buzzBP = ctx.createBiquadFilter();
    buzzBP.type = 'bandpass';
    buzzBP.frequency.value = 480;
    buzzBP.Q.value = 3.2;
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0.0055;
    buzz.connect(buzzBP); buzzBP.connect(this.buzzGain); this.buzzGain.connect(this.ambientBus);
    buzz.start(t);

    // vending machine compressor hum (gain driven by proximity)
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const humOsc = ctx.createOscillator();
    humOsc.type = 'sawtooth';
    humOsc.frequency.value = 98;
    const humLP = ctx.createBiquadFilter();
    humLP.type = 'lowpass';
    humLP.frequency.value = 340;
    humOsc.connect(humLP); humLP.connect(this.humGain); this.humGain.connect(this.ambientBus);
    humOsc.start(t);
    const humOsc2 = ctx.createOscillator();
    humOsc2.type = 'sine';
    humOsc2.frequency.value = 196;
    this.humGain2 = ctx.createGain();
    this.humGain2.gain.value = 0;
    humOsc2.connect(this.humGain2); this.humGain2.connect(this.ambientBus);
    humOsc2.start(t);

    // low tension drone (fades with proximity to Maigo)
    this.tensionGain = ctx.createGain();
    this.tensionGain.gain.value = 0;
    const droneLP = ctx.createBiquadFilter();
    droneLP.type = 'lowpass';
    droneLP.frequency.value = 320;
    const d1 = ctx.createOscillator(); d1.type = 'sawtooth'; d1.frequency.value = 55;
    const d2 = ctx.createOscillator(); d2.type = 'sawtooth'; d2.frequency.value = 82.4; d2.detune.value = -9;
    const d3 = ctx.createOscillator(); d3.type = 'triangle'; d3.frequency.value = 110; d3.detune.value = 6;
    const dg = ctx.createGain(); dg.gain.value = 0.12;
    d1.connect(dg); d2.connect(dg); d3.connect(dg);
    dg.connect(droneLP); droneLP.connect(this.tensionGain); this.tensionGain.connect(this.ambientBus);
    d1.start(t); d2.start(t); d3.start(t);

    // breathing-ish LFO on the air
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.006;
    lfo.connect(lfoGain); lfoGain.connect(this.airGain.gain);
    lfo.start(t);
  }

  /** stop whatever is speaking, so the next line starts in silence */
  cutVoice(fade = 0.12) {
    if (!this.ctx || !this._live) return;
    const t = now(this.ctx);
    for (const rec of this._live.slice()) {
      try {
        const g = rec.gain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0.0001, t + fade);
        rec.src.stop(t + fade + 0.02);
      } catch (err) { /* already stopped */ }
    }
    this._live.length = 0;
  }

  /** put the mix back to a clean starting state (restart, new run, after a scare) */
  resetVoices() {
    if (!this.ctx) return;
    const t = now(this.ctx);
    const v = this.voiceBus.gain;
    v.cancelScheduledValues(t);
    v.setValueAtTime(2.2, t);
    const m = this.master.gain;
    m.cancelScheduledValues(t);
    m.setValueAtTime(0.82, t);
    try { this.setAmbientMute(false, true); } catch (e) { /* ambient graph not up yet */ }
  }

  /** duck the rain/street bed so a spoken line cuts through, then restore */
  duckAmbientFor(seconds, level = 0.34) {
    if (!this.ctx || !this.ambientBus || this.ambientMuted) return;
    const t = now(this.ctx);
    const p = this.ambientBus.gain;
    const base = this.ambientLevel || 0.55;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(base * level, t + 0.18);
    p.linearRampToValueAtTime(base, t + Math.max(1.2, seconds) + 0.55);
  }

  setAmbientMute(on, instant = true) {
    if (!this.ctx) return;
    this.ambientMuted = on;
    const t = now(this.ctx);
    const param = this.ambientBus.gain;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(on ? 0 : this.ambientLevel, t + (instant ? 0.015 : 1.4));
    if (on) {
      // kill the drone / heartbeat immediately too
      this.tensionGain.gain.setTargetAtTime(0, t, 0.02);
      this.humGain.gain.setTargetAtTime(0, t, 0.02);
      this.humGain2.gain.setTargetAtTime(0, t, 0.02);
    }
  }

  setDread(v) {
    this.dread = v;
    if (!this.ready) return;
    const t = now(this.ctx);
    this._tensionTarget = v * 0.7;
    if (!this.ambientMuted) this.tensionGain.gain.setTargetAtTime(this._tensionTarget, t, 0.35);
  }

  setVendingProximity(d) {
    if (!this.ready) return;
    const target = THREE_clamp(1 - d / 7, 0, 1);
    this.events.hum = target;
  }

  /* --------------------------- update loop -------------------------- */
  update(dt) {
    if (!this.ready || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = now(ctx);
    if (this.ambientMuted) return;

    // heart: rate + force are set from the world each frame
    this._heartTick(dt);

    // vending hum proximity smoothing
    const humTarget = this.events.hum * 0.05;
    this.humGain.gain.setTargetAtTime(humTarget, t, 0.15);
    this.humGain2.gain.setTargetAtTime(humTarget * 0.25, t, 0.15);

    // distant traffic passes
    this.events.traffic -= dt;
    if (this.events.traffic <= 0) {
      this.distantTraffic();
      this.events.traffic = 9 + Math.random() * 14;
    }
    // distant metal / dog / shutter
    this.events.creak -= dt;
    if (this.events.creak <= 0) {
      if (Math.random() < 0.55) this.distantCreak(); else this.distantDog();
      this.events.creak = 16 + Math.random() * 22;
    }
    // heartbeat under dread
    if (this.dread > 0.28) {
      this.events.heart -= dt;
      if (this.events.heart <= 0) {
        this.heartbeat(this.dread);
        this.events.heart = 1.05 - this.dread * 0.35;
      }
    }
  }

  /* --------------------------- one shots ---------------------------- */
  distantTraffic() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(520, t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 7);
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 2.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 7.2);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.85, t);
    pan.pan.linearRampToValueAtTime(0.85, t + 7);
    src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(this.ambientBus);
    src.start(t); src.stop(t + 7.4);
  }

  distantCreak() {
    const ctx = this.ctx, t = now(ctx);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 1.8);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.016, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    o.connect(bp); bp.connect(g); g.connect(this.ambientBus); g.connect(this.reverb);
    o.start(t); o.stop(t + 2);
  }

  distantDog() {
    const ctx = this.ctx, t = now(ctx);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const tt = t + i * 0.32;
      o.frequency.setValueAtTime(420, tt);
      o.frequency.exponentialRampToValueAtTime(250, tt + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.012, tt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      o.connect(lp); lp.connect(g); g.connect(this.ambientBus);
      o.start(tt); o.stop(tt + 0.24);
    }
  }

  heartbeat(intensity = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.18;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(64, tt);
      o.frequency.exponentialRampToValueAtTime(38, tt + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.12 * intensity + 0.03, tt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + (i === 0 ? 0.18 : 0.26));
      o.connect(g); g.connect(this.sfxBus);
      o.start(tt); o.stop(tt + 0.3);
    }
  }

  footstep(intensity = 0.5, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420 + Math.random() * 140;
    const g = ctx.createGain();
    const amp = 0.05 + intensity * 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(lp); lp.connect(g); g.connect(p); p.connect(this.sfxBus);
    g.connect(this.reverb);
    src.start(t); src.stop(t + 0.2);

    // wet sole squelch
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(65, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.025 * intensity, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.13);
  }

  tick(volume = 0.06) {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1680;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
    o.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.04);
  }

  stinger() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    // sub swell
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 2.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
    o.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    o.start(t); o.stop(t + 2.9);
    // dissonant high string
    for (const [f, det] of [[1046, 0], [987, 8], [1568, -6]]) {
      const s = ctx.createOscillator();
      s.type = 'sawtooth';
      s.frequency.setValueAtTime(f * 0.9, t + 0.1);
      s.frequency.linearRampToValueAtTime(f, t + 0.8);
      s.detune.value = det;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, t + 0.1);
      sg.gain.exponentialRampToValueAtTime(0.012, t + 0.9);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
      s.connect(bp); bp.connect(sg); sg.connect(this.sfxBus); sg.connect(this.reverb);
      s.start(t + 0.1); s.stop(t + 3.3);
    }
  }

  clothRustle(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 * strength, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.5);
  }

  gravelScrape() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.45;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + 0.55);
    bp.Q.value = 1.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    src.start(t); src.stop(t + 0.65);
    // stones scattering
    for (let i = 0; i < 8; i++) {
      const tt = t + Math.random() * 0.4;
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      n.playbackRate.value = 2;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, tt);
      ng.gain.exponentialRampToValueAtTime(0.02, tt + 0.004);
      ng.gain.exponentialRampToValueAtTime(0.0001, tt + 0.06);
      n.connect(hp); hp.connect(ng); ng.connect(this.sfxBus);
      n.start(tt); n.stop(tt + 0.07);
    }
  }

  candyWrapper() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    for (let i = 0; i < 14; i++) {
      const tt = t + i * 0.045 + Math.random() * 0.03;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.playbackRate.value = 1.6 + Math.random();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 2800 + Math.random() * 2400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.02 + Math.random() * 0.025, tt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.05);
      src.connect(hp); hp.connect(g); g.connect(this.sfxBus);
      src.start(tt); src.stop(tt + 0.06);
    }
  }

  vendingBuy() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    // button bleep
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1200, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.14);
    // motor whirr
    const m = ctx.createOscillator();
    m.type = 'sawtooth';
    m.frequency.setValueAtTime(180, t + 0.12);
    const mf = ctx.createBiquadFilter(); mf.type = 'lowpass'; mf.frequency.value = 900;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(0.0001, t + 0.12);
    mg.gain.linearRampToValueAtTime(0.035, t + 0.3);
    mg.gain.linearRampToValueAtTime(0.0001, t + 1.0);
    m.connect(mf); mf.connect(mg); mg.connect(this.sfxBus);
    m.start(t + 0.12); m.stop(t + 1.05);
    // clunk of the spiral dropping
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t + 0.95);
    ng.gain.exponentialRampToValueAtTime(0.18, t + 0.97);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    n.connect(lp); lp.connect(ng); ng.connect(this.sfxBus);
    n.start(t + 0.95); n.stop(t + 1.3);
  }

  rustShift() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    const dur = 3.4;
    // groaning metal
    for (const [f, det] of [[58, 0], [87, 11], [131, -7]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 1.06, t + dur * 0.5);
      o.frequency.linearRampToValueAtTime(f * 0.92, t + dur);
      o.detune.value = det;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.055, t + 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      o.start(t); o.stop(t + dur + 0.1);
    }
    // shearing sheet metal
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.35;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp); hp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + dur);
  }

  doorChime() {
    if (!this.ready) return;
    const ctx = this.ctx, t = now(ctx);
    [880, 1174.7].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      const tt = t + i * 0.35;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.1, tt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 1.6);
      o.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      o.start(tt); o.stop(tt + 1.7);
    });
  }

  /* ==================================================================
     JAPANESE CHILD VOICE (formant synthesis)
     ================================================================== */
  /* ---- Japanese child voice ------------------------------------------
     Articulatory formant synthesis: every mora = consonant gesture
     (noise burst + formant locus) + voiced vowel with an f0 contour.
     Formant targets are adult-female Japanese values scaled for a ~10 y/o
     vocal tract, so /s/ /k/ /t/ /m/ read as consonants instead of vowels. */
  _vowelTargets(v) {
    const F = {
      a: [950, 1530, 2950],
      i: [360, 2820, 3350],
      u: [420, 1180, 2760],
      e: [590, 2380, 3050],
      o: [590, 1020, 2850],
      N: [250, 1250, 2400],
    };
    return F[v] || F.a;
  }

  _consLocus(c) {
    switch (c) {
      case 'p': case 'b': case 'm': return [300, 900, 2150];
      case 't': case 'd': case 'n': case 's': case 'ts': case 'r': return [330, 1750, 2750];
      case 'k': case 'g': return [350, 1920, 2450];
      case 'ch': case 'sh': case 'j': return [400, 2400, 3100];
      case 'y': return [320, 2400, 3100];
      case 'w': return [380, 950, 2300];
      case 'h': return [500, 1500, 2500];
      default: return null;
    }
  }

  _noise(t, dur, { f = 2000, q = 1.4, gain = 0.06, type = 'bandpass', rate = 1 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = rate;
    const bp = ctx.createBiquadFilter();
    bp.type = type; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.010, dur * 0.4));
    g.gain.linearRampToValueAtTime(0.0, t + dur);
    src.connect(bp); bp.connect(g); g.connect(this.voiceBus);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /* unvoiced / burst portion of a consonant */
  _consonant(c, t, gain = 1, gem = 0) {
    if (!c || c === 'none') return;
    const g = gain * (gem ? 1.15 : 1);
    switch (c) {
      case 's': this._noise(t, 0.10, { f: 6400, q: 1.5, gain: 0.16 * g, rate: 1.1 }); break;
      case 'sh': this._noise(t, 0.10, { f: 2900, q: 2.4, gain: 0.16 * g, rate: 1.3 }); break;
      case 'ch':
        this._noise(t, 0.028, { f: 2000, q: 1.0, gain: 0.15 * g });
        this._noise(t + 0.026, 0.07, { f: 3200, q: 2.0, gain: 0.095 * g, rate: 1.2 });
        break;
      case 'ts':
        this._noise(t, 0.022, { f: 1600, q: 1.0, gain: 0.13 * g });
        this._noise(t + 0.02, 0.075, { f: 5600, q: 2.0, gain: 0.10 * g, rate: 1.2 });
        break;
      case 'k': this._noise(t + 0.01, 0.036, { f: 1900, q: 1.5, gain: 0.16 * g }); break;
      case 't': this._noise(t + 0.01, 0.030, { f: 3800, q: 1.8, gain: 0.15 * g }); break;
      case 'p': this._noise(t + 0.008, 0.026, { f: 900, q: 1.1, gain: 0.15 * g }); break;
      case 'h': this._noise(t, 0.085, { f: 1700, q: 0.6, gain: 0.045 * g, type: 'bandpass' }); break;
      case 'j':
        this._noise(t, 0.022, { f: 2400, q: 1.1, gain: 0.05 * g });
        this._noise(t + 0.02, 0.045, { f: 2900, q: 1.8, gain: 0.04 * g });
        break;
      case 'r': this._noise(t + 0.005, 0.022, { f: 1400, q: 1.3, gain: 0.045 * g }); break;
      case 'd': this._noise(t + 0.012, 0.018, { f: 3100, q: 1.6, gain: 0.05 * g }); break;
      case 'b': this._noise(t + 0.010, 0.020, { f: 900, q: 1.1, gain: 0.055 * g }); break;
      case 'g': this._noise(t + 0.012, 0.022, { f: 1700, q: 1.4, gain: 0.055 * g }); break;
      default: break;
    }
  }

  /* one mora: CV or syllabic N */
  _mora(t, m, pitch = 1, gain = 1) {
    const ctx = this.ctx;
    const dur = m.d || 0.14;
    const vowel = m.v || 'a';
    const cons = m.c || 'none';
    const gem = m.gem || 0;
    const rise = m.rise || 0;
    const stress = m.s ?? 1;

    // geminate / glottal hold before the release
    const tStart = t + gem;
    this._consonant(cons, tStart - (cons === 'n' || cons === 'm' ? 0.02 : 0.055), gain, gem);

    const f0 = 246 * pitch * (0.975 + Math.random() * 0.05);
    const [F1, F2, F3] = this._vowelTargets(vowel);
    const loci = this._consLocus(cons) || [F1, F2, F3];
    const isNasal = cons === 'n' || cons === 'm' || vowel === 'N';

    // glottal source: saw + slightly detuned saw, softened top end
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
    o2.detune.value = 7;
    const voiceStart = tStart + (isNasal ? 0.045 : 0.02);
    for (const o of [o1, o2]) {
      o.frequency.setValueAtTime(f0 * (isNasal ? 0.94 : 1), voiceStart);
      o.frequency.linearRampToValueAtTime(f0 * (0.985 - rise * 0.02), voiceStart + dur * 0.65);
      o.frequency.linearRampToValueAtTime(f0 * (0.96 + rise * 0.22), voiceStart + dur);
    }
    // trembling child vibrato + micro jitter
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2 + Math.random() * 1.1;
    const lfoG = ctx.createGain(); lfoG.gain.value = f0 * (0.016 + Math.random() * 0.006);
    lfo.connect(lfoG); lfoG.connect(o1.frequency); lfoG.connect(o2.frequency);
    const jit = ctx.createOscillator(); jit.frequency.value = 12 + Math.random() * 6;
    const jitG = ctx.createGain(); jitG.gain.value = f0 * 0.006;
    jit.connect(jitG); jitG.connect(o2.frequency);

    const srcGain = ctx.createGain(); srcGain.gain.value = 0.5;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 4200; tone.Q.value = 0.5;
    o1.connect(srcGain); o2.connect(srcGain); srcGain.connect(tone);

    // three parallel formants; frequencies glide from the consonant locus
    const formants = [[F1, 3.6, 1.30], [F2, 4.6, 0.78], [F3, 5.4, 0.26]];
    const env = ctx.createGain();
    const peak = (isNasal ? 0.14 : 0.30) * stress * gain;
    // gentle attack + a real release tail: exponential jumps to 1e-4 are what
    // produced the digital "crack" between syllables
    env.gain.setValueAtTime(0.0, voiceStart);
    env.gain.linearRampToValueAtTime(peak, voiceStart + 0.040);
    env.gain.linearRampToValueAtTime(peak * 0.74, voiceStart + dur * 0.70);
    env.gain.linearRampToValueAtTime(0.0, voiceStart + dur + 0.075);

    for (let i = 0; i < 3; i++) {
      const [tf, q, amp] = formants[i];
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = q;
      bp.frequency.setValueAtTime(loci[i], voiceStart);
      bp.frequency.linearRampToValueAtTime(tf, voiceStart + 0.042);
      const bg = ctx.createGain(); bg.gain.value = amp;
      tone.connect(bp); bp.connect(bg); bg.connect(env);
    }
    // nasal murmur / low body
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass'; low.frequency.value = isNasal ? 380 : 300; low.Q.value = 1.6;
    const lowG = ctx.createGain(); lowG.gain.value = isNasal ? 0.5 : 0.16;
    tone.connect(low); low.connect(lowG); lowG.connect(env);

    env.connect(this.voiceBus);
    if (this.voiceSend) env.connect(this.voiceSend);

    // breath layer — always present, stronger on h / aspirated stops
    const asp = ctx.createBufferSource();
    asp.buffer = this.noiseBuf; asp.playbackRate.value = 1.0;
    const aspBP = ctx.createBiquadFilter();
    aspBP.type = 'bandpass'; aspBP.frequency.value = 1900; aspBP.Q.value = 0.7;
    const aspG = ctx.createGain();
    aspG.gain.setValueAtTime(0.0001, voiceStart);
    aspG.gain.linearRampToValueAtTime(0.022 * stress, voiceStart + 0.03);
    aspG.gain.exponentialRampToValueAtTime(0.0001, voiceStart + dur);
    asp.connect(aspBP); aspBP.connect(aspG); aspG.connect(this.voiceBus);

    const stopAt = voiceStart + dur + 0.14;   // past the release tail
    o1.start(voiceStart); o1.stop(stopAt);
    o2.start(voiceStart); o2.stop(stopAt);
    lfo.start(voiceStart); lfo.stop(stopAt);
    jit.start(voiceStart); jit.stop(stopAt);
    asp.start(voiceStart); asp.stop(stopAt);
  }

  /**
   * Say the lost-child line. vocative: 'ojisan' (adult) | 'oneesan' (student).
   * Returns the duration in seconds so the subtitle can stay in sync.
   */
  /* ==================================================================
     BAKED JAPANESE VOICE
     The formant synthesiser below is kept only as a fallback. The lines
     the player actually hears are real recordings of Japanese speech,
     decoded once into buffers so playback can never stutter with the
     frame rate — the audio thread owns them from then on.
     ================================================================== */
  voiceUrl(name) {
    const canMp4 = this._probe && this._probe.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    const ext = canMp4 ? 'm4a' : 'ogg';
    return `assets/voice/${name}.${ext}`;
  }

  async preloadVoice() {
    if (!this.ctx) return;
    if (!this._probe) this._probe = new Audio();
    this.voiceBuf = this.voiceBuf || {};
    const names = [
      'maigo_ask_ojisan', 'maigo_ask_oneesan',
      'reply_student_yes', 'reply_student_no',
      'reply_adult_yes', 'reply_adult_no',
      'laugh_child', 'whisper_sorry',
    ];
    await Promise.all(names.map(async (n) => {
      if (this.voiceBuf[n]) return;
      try {
        const res = await fetch(this.voiceUrl(n), { cache: 'force-cache' });
        if (!res.ok) return;
        const raw = await res.arrayBuffer();
        this.voiceBuf[n] = await this.ctx.decodeAudioData(raw.slice(0));
      } catch (err) {
        // leave it undefined — the synthesiser will take over for that line
      }
    }));
  }

  /** decode one line on demand; resolves to its duration (0 on failure) */
  async loadVoiceLine(name) {
    if (this.voiceBuf && this.voiceBuf[name]) return this.voiceBuf[name].duration;
    if (!this.ctx) return 0;
    if (!this._probe) this._probe = new Audio();
    try {
      const res = await fetch(this.voiceUrl(name));
      if (!res.ok) return 0;
      const buf = await this.ctx.decodeAudioData((await res.arrayBuffer()).slice(0));
      this.voiceBuf = this.voiceBuf || {};
      this.voiceBuf[name] = buf;
      return buf.duration;
    } catch (err) { return 0; }
  }

  /** play a decoded buffer; returns its duration in seconds (0 if absent) */
  _playVoice(name, { gain = 1.0, rate = 1.0, bus = null, pan = null } = {}) {
    const buf = this.voiceBuf && this.voiceBuf[name];
    if (!buf || !this.ctx || this.ctx.state !== 'running') return 0;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const g = ctx.createGain();
    g.gain.value = gain;
    this._live = this._live || [];
    const rec = { src, gain: g };
    this._live.push(rec);
    src.onended = () => {
      const i = this._live.indexOf(rec);
      if (i >= 0) this._live.splice(i, 1);
    };
    let head = g;
    if (pan !== null && ctx.createStereoPanner) {
      // place the giggle to the player's left or right
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      head = p;
    }
    src.connect(g);
    head.connect(bus || this.voiceComp || this.voiceBus || this.master);

    // a light room send so she sits in the alley
    if (this.voiceSend) {
      const send = ctx.createGain();
      send.gain.value = 0.22;
      g.connect(send);
      send.connect(this.reverb);
    }
    src.start(now(ctx) + 0.02);
    return buf.duration / rate;
  }

  speakQuestion(vocative = 'ojisan') {
    if (!this.ready) return 0;

    // the real thing, if it decoded
    const baked = vocative === 'ojisan' ? 'maigo_ask_ojisan' : 'maigo_ask_oneesan';
    const dur = this._playVoice(baked, { gain: 1.0 });
    if (dur > 0) return dur;

    // ---- fallback: formant synthesis ----
    const t0 = now(this.ctx) + 0.18;

    const M = (c, v, d, extra = {}) => ({ c, v, d, ...extra });
    const R = (d) => ({ rest: d });

    const call = vocative === 'ojisan'
      ? [M('none', 'o', 0.15), M('j', 'i', 0.16), M('s', 'a', 0.15), M('n', 'N', 0.19)]
      : [M('none', 'o', 0.15), M('n', 'e', 0.16), M('none', 'e', 0.17), M('s', 'a', 0.15), M('n', 'N', 0.19)];

    const seq = [
      M('none', 'a', 0.16, { s: 0.85 }),
      M('n', 'o', 0.17, { s: 0.9 }),
      R(0.30),
      ...call,
      R(0.30),
      M('m', 'i', 0.14),
      M('ch', 'i', 0.14),
      M('n', 'i', 0.14),
      M('m', 'a', 0.15),
      M('y', 'o', 0.16),
      M('ch', 'a', 0.17, { gem: 0.055 }),
      M('t', 'e', 0.15, { gem: 0.06 }),
      R(0.34),
      M('none', 'o', 0.14),
      M('none', 'u', 0.13),
      M('ch', 'i', 0.14),
      M('m', 'a', 0.14),
      M('d', 'e', 0.14),
      M('ts', 'u', 0.15),
      M('r', 'e', 0.14),
      M('t', 'e', 0.14),
      M('none', 'i', 0.13),
      M('t', 'e', 0.14, { gem: 0.06 }),
      M('k', 'u', 0.14),
      M('r', 'e', 0.14),
      M('m', 'a', 0.14),
      M('s', 'e', 0.14),
      M('n', 'N', 0.17),
      M('k', 'a', 0.34, { rise: 1, s: 1.05 }),
    ];

    const voiced = seq.filter((x) => !x.rest).length;
    let n = 0;
    let t = t0;
    for (const m of seq) {
      if (m.rest) { t += m.rest; continue; }
      // gentle declination across the sentence, then lift on the final か
      const decl = 1.06 - (n / Math.max(1, voiced - 1)) * 0.14;
      this._mora(t, m, decl, 1);
      t += (m.gem || 0) + m.d + 0.012;
      n++;
    }
    return t - t0;
  }

  /* ==================================================================
     THE PLAYER'S OWN VOICE
     A darker, chestier instrument: same mora engine, dropped an octave and a
     half, low-passed so it sits under her thin child's voice.
     ================================================================== */
  /** the shadow-tag giggle: spatial, so it reads as coming from the alley */
  childLaugh(pan = 0) {
    if (!this.ready) return 0;
    // a distant giggle, off to one side and a little behind the rain
    return this._playVoice('laugh_child', {
      gain: 1.05, pan, bus: this.voiceComp || this.voiceBus,
    });
  }

  /** the whisper at sixty metres */
  whisperSorry() {
    if (!this.ready) return 0;
    const d = this._playVoice('whisper_sorry', { gain: 0.9 });
    this.duckAmbientFor(Math.max(2.4, d || 2.4), 0.18);
    return d;
  }

  speakReply(kind = 'yes', identity = 'student') {
    if (!this.ready) return 0;

    const who = identity === 'adult' ? 'adult' : 'student';
    const baked = `reply_${who}_${kind === 'yes' ? 'yes' : 'no'}`;
    const dur = this._playVoice(baked, { gain: 1.45 });
    if (dur > 0) { this.duckAmbientFor(dur); return dur; }

    // Not decoded yet. Decode first, then play. The formant synthesiser is the
    // last resort for a genuinely missing file — never for a slow buffer, or
    // the player hears the stuttering robot voice instead of the recording.
    this.loadVoiceLine(baked)
      .then(() => {
        if (!this.ctx || this.ctx.state !== 'running') return;
        const d = this._playVoice(baked, { gain: 1.45 });
        if (d > 0) this.duckAmbientFor(d);
      })
      .catch(() => this._speakReplyFormant(kind));
    return 2.4;
  }

  /** last-resort synthetic reply, kept for a missing asset only */
  _speakReplyFormant(kind = 'yes') {
    if (!this.ready) return 0;

    const t0 = now(this.ctx) + 0.12;
    const M = (c, v, d, extra = {}) => ({ c, v, d, ...extra });
    const R = (d) => ({ rest: d });

    // 「はい。家まで送ります。」 / 「いいえ。関わらない。」
    const seq = kind === 'yes'
      ? [
        M('h', 'a', 0.15), M('none', 'i', 0.20), R(0.26),
        M('none', 'i', 0.13), M('none', 'e', 0.15), R(0.18),
        M('m', 'a', 0.14), M('d', 'e', 0.14), R(0.10),
        M('none', 'o', 0.13), M('k', 'u', 0.13), M('r', 'i', 0.13),
        M('sh', 'i', 0.13), M('m', 'a', 0.14), M('s', 'u', 0.24, { rise: 0.7 }),
      ]
      : [
        M('none', 'i', 0.16), M('none', 'i', 0.17), M('none', 'e', 0.22), R(0.26),
        M('k', 'a', 0.15), M('k', 'a', 0.15), M('w', 'a', 0.14),
        M('r', 'a', 0.14), M('n', 'a', 0.14), M('none', 'i', 0.30, { rise: 1 }),
      ];

    // darker timber: an octave down, plus a shelf cut on the way out
    const dark = this.ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2600;
    dark.Q.value = 0.6;
    dark.connect(this.voiceBus);

    const prevBus = this.voiceBus;
    let t = t0;
    const n = seq.filter((x) => !x.rest).length;
    let i = 0;
    for (const m of seq) {
      if (m.rest) { t += m.rest; continue; }
      const decl = 1.02 - (i / Math.max(1, n - 1)) * 0.10;
      this._mora(t, m, 0.54 * decl, 1.15);
      t += (m.gem || 0) + m.d + 0.014;
      i++;
    }
    void prevBus;
    return t - t0;
  }

  /* ==================================================================
     PIANO — a slow, unresolved motif for the title and the alley
     Additive synthesis: struck partials with inharmonic stretch and
     independent decays, which is what makes a piano sound struck rather
     than bowed.
     ================================================================== */
  pianoNote(freq, when, vel = 0.5, dur = 4.0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const partials = [
      [1, 1.00, 1.00], [2.001, 0.46, 1.35], [3.004, 0.26, 1.9],
      [4.01, 0.15, 2.6], [5.02, 0.085, 3.4], [6.03, 0.05, 4.4],
    ];
    const out = ctx.createGain();
    out.gain.value = vel * 0.15;

    // felt / hammer noise, the "thock" at the onset
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.noiseBuf;
    hammer.playbackRate.value = 1.4;
    const hbp = ctx.createBiquadFilter();
    hbp.type = 'bandpass'; hbp.frequency.value = 2200; hbp.Q.value = 1.1;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0, when);
    hg.gain.linearRampToValueAtTime(vel * 0.045, when + 0.004);
    hg.gain.linearRampToValueAtTime(0.0, when + 0.09);
    hammer.connect(hbp); hbp.connect(hg); hg.connect(out);

    for (const [mult, amp, decay] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * mult, when);
      // slight detune drift as the string settles
      o.frequency.linearRampToValueAtTime(freq * mult * 1.0009, when + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, when);
      g.gain.linearRampToValueAtTime(amp, when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0005, when + dur * decay * 0.5);
      o.connect(g); g.connect(out);
      o.start(when); o.stop(when + dur * decay * 0.5 + 0.05);
    }

    // a little room so it is not a dry beep
    out.connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    out.connect(send); send.connect(this.reverb);

    hammer.start(when); hammer.stop(when + 0.12);
  }

  /* ==================================================================
     NARRATION — the intro card's storyteller
     ================================================================== */
  playNarration(name) {
    const dur = this._playVoice(name, { gain: 1.0, bus: this.voiceComp || this.voiceBus });
    this._narrationName = name;
    return dur;
  }

  stopNarration() {
    // the voice nodes are one-shots; a hard stop would click, so just duck
    if (this.voiceComp && this.ctx) {
      const t = now(this.ctx);
      try {
        this.voiceComp.threshold.setTargetAtTime(-60, t, 0.05);
        this.voiceComp.threshold.setTargetAtTime(-20, t + 0.35, 0.2);
      } catch (e) { /* noop */ }
    }
    this._narrationName = null;
  }

  /** drop the title theme to a low bed (0..1 of its normal level) */
  duckPiano(v = 0.12) {
    const el = this._pianoEl;
    if (!el) return;
    if (this._pianoFadeTimer) clearInterval(this._pianoFadeTimer);
    const from = el.volume || 0;
    const t0 = performance.now();
    this._pianoFadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      try { el.volume = Math.max(0, from + (v - from) * k); } catch (e) { /* noop */ }
      if (k >= 1) clearInterval(this._pianoFadeTimer);
    }, 40);
  }

  /* ==================================================================
     TITLE THEME — a real recording, not a synthesiser
     Gymnopédie No. 1, Erik Satie (public domain), performed by Michael
     Laucke (public domain, Wikimedia Commons). Streamed from ./assets and
     faded in by hand so it never announces itself with a click.
     ================================================================== */
  /* ==================================================================
     INTRO BED — the CC0 piano from archive.org/details/piano_tune,
     sitting far under the narration on the black card.
     ================================================================== */
  prepareIntroBed() {
    if (this._bedEl || this._bedBroken) return this._bedEl;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.crossOrigin = 'anonymous';
    el.volume = 0;
    el.src = 'assets/audio/piano_intro.mp3';
    el.addEventListener('error', () => {
      console.warn('[Audio] intro bed unavailable — the card stays silent');
      this._bedBroken = true;
      this._bedEl = null;
    });
    this._bedEl = el;
    return el;
  }

  startIntroBed(level = 0.14, fadeMs = 2600) {
    const el = this.prepareIntroBed();
    if (!el) return;
    this._bedLevel = level;
    if (this._bedFade) clearInterval(this._bedFade);
    const t0 = performance.now();
    const from = el.volume || 0;
    const play = () => {
      const pr = el.play();
      if (pr && pr.catch) {
        // a page that reached the card without a gesture: start on the next one
        pr.catch(() => {
          const kick = () => {
            document.removeEventListener('pointerdown', kick);
            document.removeEventListener('keydown', kick);
            el.play().catch(() => {});
          };
          document.addEventListener('pointerdown', kick, { once: true });
          document.addEventListener('keydown', kick, { once: true });
        });
      }
    };
    play();
    this._bedFade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / fadeMs);
      try { el.volume = Math.max(0, Math.min(1, from + (level - from) * k)); } catch (e) { /* noop */ }
      if (k >= 1) { clearInterval(this._bedFade); this._bedFade = null; }
    }, 50);
  }

  stopIntroBed(fadeMs = 1200) {
    const el = this._bedEl;
    if (!el) return;
    if (this._bedFade) { clearInterval(this._bedFade); this._bedFade = null; }
    const from = el.volume || 0;
    const t0 = performance.now();
    this._bedFade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / fadeMs);
      try { el.volume = Math.max(0, from * (1 - k)); } catch (e) { /* noop */ }
      if (k >= 1) {
        clearInterval(this._bedFade);
        this._bedFade = null;
        try { el.pause(); } catch (e) { /* noop */ }
      }
    }, 50);
  }

  /* the recorded scream, decoded once so the slam never waits on a fetch */
  async preloadSlam() {
    if (this.slamBuf || this._slamLoading) return;
    this._slamLoading = true;
    try {
      const res = await fetch('assets/audio/scream_slam.mp3', { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const raw = await res.arrayBuffer();
      if (!this.ctx) {
        // fetched before the first gesture — decode happens in init()
        this._slamRaw = raw;
        return;
      }
      this.slamBuf = await this.ctx.decodeAudioData(raw.slice(0));
    } catch (err) {
      this.slamBuf = null;             // the synth layers carry the scare instead
    } finally {
      this._slamLoading = false;
    }
  }

  preparePianoLoop() {
    if (this._pianoEl) return this._pianoEl;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.crossOrigin = 'anonymous';
    el.volume = 0;
    // m4a first (universal), ogg for browsers without AAC
    const canOgg = el.canPlayType && el.canPlayType('audio/ogg; codecs="vorbis"');
    const canMp4 = el.canPlayType && el.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    el.src = canMp4 || !canOgg ? 'assets/title-theme.m4a' : 'assets/title-theme.ogg';
    el.addEventListener('error', () => {
      console.warn('[Audio] title theme unavailable — falling back to the synth piano');
      this._pianoElBroken = true;
      this._pianoEl = null;
    });
    this._pianoEl = el;
    this._pianoVolume = 0;
    return el;
  }

  startPianoLoop(target = 0.42) {
    if (this._pianoElBroken) { this.pianoMystery(); return; }
    const el = this.preparePianoLoop();
    if (el.dataset && el.dataset.playing === '1') return;

    const play = el.play();
    if (play && play.catch) {
      play.catch(() => {          // still blocked: try again on the next gesture
        this._pianoNeedsGesture = true;
      });
    }
    if (this._pianoNeedsGesture) return;
    el.dataset.playing = '1';

    // hand-rolled fade-in — 2.4 s, so the first chord arrives rather than lands
    if (this._pianoFadeTimer) clearInterval(this._pianoFadeTimer);
    const t0 = performance.now();
    this._pianoFadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 2400);
      this._pianoVolume = target * k * k;
      try { el.volume = Math.max(0, Math.min(1, this._pianoVolume)); } catch (e) { /* noop */ }
      if (k >= 1) clearInterval(this._pianoFadeTimer);
    }, 50);
  }

  stopPianoLoop(fadeMs = 2200) {
    const el = this._pianoEl;
    if (!el) return;
    if (this._pianoFadeTimer) clearInterval(this._pianoFadeTimer);
    const from = el.volume || 0;
    const t0 = performance.now();
    this._pianoFadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / fadeMs);
      try { el.volume = Math.max(0, from * (1 - k)); } catch (e) { /* noop */ }
      if (k >= 1) {
        clearInterval(this._pianoFadeTimer);
        try { el.pause(); } catch (e) { /* noop */ }
        if (el.dataset) el.dataset.playing = '0';
      }
    }, 50);
  }

  /** a suspended, unresolved phrase — A minor with a flattened sixth */
  pianoMystery() {
    if (!this.ready || this._pianoOn) return;
    this._pianoOn = true;
    const A2 = 110.0, C3 = 130.81, E3 = 164.81, F3 = 174.61, B2 = 123.47, D3 = 146.83;
    // [beat, frequency, velocity] — 5.2 s per phrase, never resolving
    const phrase = [
      [0.0, A2, 0.55], [0.0, E3, 0.30],
      [1.6, C3, 0.42],
      [3.1, F3, 0.38],
      [4.4, B2, 0.34], [4.4, D3, 0.22],
      [7.0, A2, 0.48], [7.0, C3, 0.26],
      [8.6, E3, 0.36],
      [10.2, F3, 0.30],
      [11.8, E3, 0.28], [11.8, B2, 0.24],
    ];

    const beatMs = 620;
    const play = () => {
      if (!this._pianoOn) return;
      const start = now(this.ctx) + 0.06;
      for (const [beat, freq, vel] of phrase) {
        this.pianoNote(freq, start + (beat * beatMs) / 1000, vel, 5.0);
      }
      const total = 13.2 * beatMs;
      this._pianoTimer = setTimeout(() => {
        if (!this._pianoOn) return;
        if (this._pianoStep === undefined) this._pianoStep = 0;
        this._pianoStep++;
        // alternate the tail so the loop never feels like a ringtone
        if (this._pianoStep % 3 === 2) {
          this.pianoNote(196.0, start + 14.6 * beatMs / 1000, 0.26, 5.5); // G3
        }
        play();
      }, total);
    };
    play();
  }

  pianoStop() {
    this._pianoOn = false;
    if (this._pianoTimer) clearTimeout(this._pianoTimer);
    this._pianoTimer = null;
  }

  /* ==================================================================
     HEART — rate and force driven by how far she is from you
     ================================================================== */
  setHeart(bpm, force = 0.4) {
    // 0 means "no heartbeat at all" — used on the title and the board
    this._heartBpm = bpm <= 0 ? 0 : Math.max(46, Math.min(168, bpm));
    this._heartForce = Math.max(0, Math.min(1, force));
  }

  _heartTick(dt) {
    if (!this._heartBpm) return;
    this._heartAcc = (this._heartAcc || 0) + dt;
    const period = 60 / this._heartBpm;
    if (this._heartAcc >= period) {
      this._heartAcc -= period;
      this.heartbeat(0.25 + this._heartForce * 0.9);
    }
  }

  /* ------------------------------- jumpscare ------------------------ */
  /* ==================================================================
     THE SLAM — what a lose condition actually sounds like.
     A saturated scream, a sub-bass drop under it, and an impact that
     hits on the same frame the face arrives.
     ================================================================== */
  slam() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t = now(ctx);

    // the voice bus is out of the way for three seconds, then comes back
    this.setAmbientMute(true);
    this.voiceBus.gain.cancelScheduledValues(t);
    this.voiceBus.gain.setValueAtTime(0, t + 0.02);
    this.voiceBus.gain.setValueAtTime(0, t + 2.2);
    this.voiceBus.gain.linearRampToValueAtTime(2.2, t + 2.6);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(1.0, t);
    this.master.gain.setValueAtTime(1.0, t + 2.2);
    this.master.gain.linearRampToValueAtTime(0.82, t + 2.6);

    // one hard-clipped bus for the whole event, then the house limiter
    const bus = ctx.createGain();
    bus.gain.value = 0.92;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) {
      const x = (i / 4096) * 2 - 1;
      curve[i] = Math.tanh(x * 4.2);
    }
    clip.curve = curve;
    clip.oversample = '4x';
    bus.connect(clip);
    clip.connect(this.comp);

    // ---- 0. the recorded scream (CC0, archive.org/details/piano_tune).
    //         It is the voice of the scare; the synth layers below are only
    //         the body around it — or the whole thing if it never loaded.
    const hasReal = !!(this.slamBuf && this.slamBuf.duration > 0.2);
    if (hasReal) {
      const src = ctx.createBufferSource();
      src.buffer = this.slamBuf;
      src.playbackRate.setValueAtTime(1.0, t);
      src.playbackRate.linearRampToValueAtTime(0.93, t + 2.1);

      const drive = ctx.createWaveShaper();
      const dcurve = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) {
        const x = (i / 2048) * 2 - 1;
        dcurve[i] = Math.tanh(x * 3.4);
      }
      drive.curve = dcurve;
      drive.oversample = '4x';

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(7000, t);
      lp.frequency.exponentialRampToValueAtTime(900, t + 2.0);
      lp.Q.value = 0.7;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 70;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.0, t + 0.01);
      g.gain.setValueAtTime(0.95, t + 1.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.28);

      src.connect(hp); hp.connect(drive); drive.connect(lp); lp.connect(g); g.connect(bus);
      src.start(t); src.stop(t + 2.3);
    }
    const support = hasReal ? 0.32 : 1.0;

    // ---- 1. the scream bed: two detuned saws + noise, swept and saturated ----
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.85 * support, t + 0.012);
    env.gain.setValueAtTime(0.80 * support, t + 0.42);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    env.connect(bus);

    const screamFilter = ctx.createBiquadFilter();
    screamFilter.type = 'bandpass';
    screamFilter.frequency.setValueAtTime(2800, t);
    screamFilter.frequency.exponentialRampToValueAtTime(420, t + 1.9);
    screamFilter.Q.value = 1.1;
    screamFilter.connect(env);

    for (const [type, f, det] of [['sawtooth', 520, 0], ['sawtooth', 520, 17], ['square', 261, -9]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.32, t + 1.6);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = type === 'square' ? 0.22 : 0.34;
      o.connect(g); g.connect(screamFilter);
      o.start(t); o.stop(t + 2.2);
    }

    const shriek = ctx.createBufferSource();
    shriek.buffer = this.noiseBuf;
    shriek.loop = true;
    shriek.playbackRate.setValueAtTime(1.7, t);
    shriek.playbackRate.linearRampToValueAtTime(0.65, t + 2.0);
    const shriekG = ctx.createGain();
    shriekG.gain.value = 0.5;
    shriek.connect(shriekG); shriekG.connect(screamFilter);
    shriek.start(t); shriek.stop(t + 2.15);

    // ---- 2. the sub drop: 92 Hz down to 24 Hz, chest first ----
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(92, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 1.5);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, t);
    subG.gain.exponentialRampToValueAtTime(0.95, t + 0.03);
    subG.gain.setValueAtTime(0.9, t + 0.5);
    subG.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    const subDrive = ctx.createWaveShaper();
    const sq = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1024) * 2 - 1; sq[i] = Math.tanh(x * 2.2); }
    subDrive.curve = sq;
    sub.connect(subG); subG.connect(subDrive); subDrive.connect(bus);
    sub.start(t); sub.stop(t + 2.7);

    // ---- 3. the impact: a noise crack over everything at frame zero ----
    const hit = ctx.createBufferSource();
    hit.buffer = this.brownBuf;
    const hitG = ctx.createGain();
    hitG.gain.setValueAtTime(0.9, t);
    hitG.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    const hitLP = ctx.createBiquadFilter();
    hitLP.type = 'lowpass';
    hitLP.frequency.setValueAtTime(1800, t);
    hitLP.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    hit.connect(hitLP); hitLP.connect(hitG); hitG.connect(bus);
    hit.start(t); hit.stop(t + 0.34);

    // a second, harder hit at the moment the face scales in
    const hit2 = ctx.createBufferSource();
    hit2.buffer = this.noiseBuf;
    const hit2G = ctx.createGain();
    hit2G.gain.setValueAtTime(0.7, t + 0.09);
    hit2G.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    hit2.connect(hit2G); hit2G.connect(bus);
    hit2.start(t + 0.09); hit2.stop(t + 0.24);
  }

  /** vol: 1 = the mild house scare; higher is used by shadow-tag's execution */
  jumpscare(vol = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t = now(ctx);

    this.setAmbientMute(true);
    this.voiceBus.gain.cancelScheduledValues(t);
    this.voiceBus.gain.setValueAtTime(0, t);
    // ...and give it back once the scream is over. Leaving this at zero muted
    // every later line in the run, which read as "the game has no voice".
    this.voiceBus.gain.setValueAtTime(0, t + 2.0);
    this.voiceBus.gain.linearRampToValueAtTime(2.2, t + 2.4);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(1.0, t);
    this.master.gain.setValueAtTime(1.0, t + 2.0);
    this.master.gain.linearRampToValueAtTime(0.82, t + 2.4);   // and back to the mix

    const screamBus = ctx.createGain();
    screamBus.gain.setValueAtTime(0.0001, t);
    screamBus.gain.exponentialRampToValueAtTime(0.34, t + 0.03);
    screamBus.gain.setValueAtTime(0.30, t + 0.55);
    screamBus.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);

    const dist = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      const x = (i / 2048) * 2 - 1;
      curve[i] = Math.tanh(x * 2.6);
    }
    dist.curve = curve;
    dist.oversample = '4x';

    const screamBP = ctx.createBiquadFilter();
    screamBP.type = 'bandpass';
    screamBP.frequency.setValueAtTime(2600, t);
    screamBP.frequency.exponentialRampToValueAtTime(520, t + 1.8);
    screamBP.Q.value = 0.9;

    const screamGain = ctx.createGain();
    screamGain.gain.value = 0.9;

    dist.connect(screamBP); screamBP.connect(screamGain); screamGain.connect(screamBus);
    // one boost on the whole scream, so a louder variant stays a single knob
    const boost = ctx.createGain();
    boost.gain.value = Math.max(0.0001, vol);
    screamBus.connect(boost);
    boost.connect(this.comp);

    // white-noise shriek
    const shriek = ctx.createBufferSource();
    shriek.buffer = this.noiseBuf;
    shriek.loop = true;
    shriek.playbackRate.setValueAtTime(1.4, t);
    shriek.playbackRate.linearRampToValueAtTime(0.7, t + 2.2);
    shriek.connect(dist);
    shriek.start(t); shriek.stop(t + 2.6);

    // vocal-fold scream cluster
    for (const [freq, det] of [[880, 0], [1245, 9], [1660, -12], [2330, 5]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.18, t + 2.0);
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.16, t);
      og.gain.linearRampToValueAtTime(0.08, t + 1.4);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 2.3);
      o.connect(og); og.connect(dist);
      o.start(t); o.stop(t + 2.4);
    }

    // sub-bass drop
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(88, t);
    sub.frequency.exponentialRampToValueAtTime(19, t + 2.4);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.85, t + 0.05);
    subGain.gain.setValueAtTime(0.85, t + 1.2);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.7);
    sub.connect(subGain); subGain.connect(this.comp);
    sub.start(t); sub.stop(t + 2.8);

    // metallic impact
    const impact = ctx.createBufferSource();
    impact.buffer = this.brownBuf;
    const impactLP = ctx.createBiquadFilter();
    impactLP.type = 'lowpass'; impactLP.frequency.value = 260;
    const impactG = ctx.createGain();
    impactG.gain.setValueAtTime(0.0001, t);
    impactG.gain.exponentialRampToValueAtTime(0.9, t + 0.01);
    impactG.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    impact.connect(impactLP); impactLP.connect(impactG); impactG.connect(this.comp);
    impact.start(t); impact.stop(t + 0.7);

    // keep the limiter hot
    this.comp.threshold.setValueAtTime(-10, t);
  }

  /** End-of-game gentle fade. */
  fadeOut(duration = 2.5) {
    if (!this.ctx) return;
    const t = now(this.ctx);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + duration);
  }
}

function THREE_clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
