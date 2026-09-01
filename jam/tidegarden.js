/*
 * TIDE GARDEN — generative jam garden
 * Engine (Melody): CONST/PALETTE, Theory, Bus, Voices, Scheduler, Garden, Store, engine assembly
 * UI (Pixel):      Input, Renderer, FX, Radial, Dock, Cursor, boot
 * One IIFE, zero dependencies. Exports window.TideGarden.
 */
(function () {
  'use strict';

  // ===== CONST/PALETTE =====
  const CONST = Object.freeze({
    STEPS: 16,
    MAX_SEEDS: 24,
    MAX_POLY: 12,
    STEP_ONSETS: 8,
    MIDI_LO: 48,
    MIDI_HI: 83,
    TIDE_LOW: 0.15,
    TIDE_HIGH: 0.85,
    LOOKAHEAD: 0.1,     // seconds
    TICK_MS: 25,        // scheduler tick
    HIT_RADIUS: 24,     // px, seed hit test
    DRAG_THRESH: 8,     // px
    HOLD_MS: 350,       // radial menu hold
    DTAP_MS: 250,       // double-tap window
    FLING: 1500         // px/s, uproot fling
  });

  const PALETTE = Object.freeze({
    bg: '#0B1626',
    bgLow: '#050A14',
    bgHigh: '#12253D',
    bloom: '#FF8A6B',
    drift: '#3FBFB0',
    pulse: '#E8C97A',
    text: '#C9D6E8'
  });

  // ===== Theory =====
  const Theory = (function () {
    const SCALES = {
      ionian:     [0, 2, 4, 5, 7, 9, 11],
      dorian:     [0, 2, 3, 5, 7, 9, 10],
      mixolydian: [0, 2, 4, 5, 7, 9, 10],
      aeolian:    [0, 2, 3, 5, 7, 8, 10],
      majPent:    [0, 2, 4, 7, 9],
      minPent:    [0, 3, 5, 7, 10]
    };
    // Chord cycle as scale degrees, 2 bars per chord = 8-bar loop.
    const CYCLES = {
      ionian:     [0, 5, 3, 4],  // I–vi–IV–V
      mixolydian: [0, 5, 3, 4],
      dorian:     [0, 5, 2, 6],  // i–VI–III–VII
      aeolian:    [0, 5, 2, 6],
      majPent:    [0, 4, 1, 3],
      minPent:    [0, 4, 1, 3]
    };
    const STRONG_STEPS = new Set([0, 4, 8, 12]);

    function scale(mode) { return SCALES[mode] || SCALES.ionian; }

    // Chord tones for current bar: stacked scale-thirds on cycle degree.
    function chordDegrees(mode, barIdx) {
      const cyc = CYCLES[mode] || CYCLES.ionian;
      const deg = cyc[Math.floor(barIdx / 2) % cyc.length];
      const n = scale(mode).length;
      return [deg % n, (deg + 2) % n, (deg + 4) % n];
    }

    // Map normalized y (0 top .. 1 bottom) to a midi note on the 2-octave lattice.
    // degOff shifts the lattice index by whole scale degrees (mutation drift).
    function yToMidi(y, root, mode, degOff) {
      const sc = scale(mode);
      const span = sc.length * 3; // 3 octaves of lattice indices clipped to MIDI range
      let idx = Math.round((1 - y) * (span - 1)) + (degOff | 0);
      idx = Math.min(span - 1, Math.max(0, idx));
      const oct = Math.floor(idx / sc.length);
      const midi = CONST.MIDI_LO + root + oct * 12 + sc[idx % sc.length];
      return Math.min(CONST.MIDI_HI, Math.max(CONST.MIDI_LO, midi));
    }

    // Snap midi to nearest chord tone (strong beats) or scale tone.
    function snap(midi, root, mode, barIdx, stepIdx) {
      const sc = scale(mode);
      const strong = STRONG_STEPS.has(stepIdx);
      const allowedPCs = strong
        ? chordDegrees(mode, barIdx).map(d => (root + sc[d]) % 12)
        : sc.map(iv => (root + iv) % 12);
      let best = midi, bestDist = Infinity;
      for (let m = midi - 6; m <= midi + 6; m++) {
        if (m < CONST.MIDI_LO || m > CONST.MIDI_HI) continue;
        if (allowedPCs.includes(((m % 12) + 12) % 12)) {
          const d = Math.abs(m - midi);
          if (d < bestDist) { bestDist = d; best = m; }
        }
      }
      return best;
    }

    function isChordTone(midi, root, mode, barIdx) {
      const sc = scale(mode);
      const pcs = chordDegrees(mode, barIdx).map(d => (root + sc[d]) % 12);
      return pcs.includes(((midi % 12) + 12) % 12);
    }

    function isStrongStep(stepIdx) { return STRONG_STEPS.has(stepIdx); }

    // Auto velocity: chord tone on strong beat 1.0, chord tone 0.85, passing 0.7.
    function velocity(midi, root, mode, barIdx, stepIdx) {
      const ct = isChordTone(midi, root, mode, barIdx);
      if (ct && isStrongStep(stepIdx)) return 1.0;
      if (ct) return 0.85;
      return 0.7;
    }

    function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    // Euclidean rhythm: k onsets in n steps (Bjorklund via rounding), rotated.
    // Memoized (16x16 combos for n=16) — resolveStep calls this per seed per
    // step, so the cache removes a per-step array allocation entirely.
    const euclidCache = new Map();
    function euclid(k, n, rot) {
      const key = k * 1000 + n * 20 + rot;
      let pat = euclidCache.get(key);
      if (pat) return pat;
      pat = new Array(n).fill(false);
      if (k > 0) {
        for (let i = 0; i < n; i++) {
          pat[(i + rot) % n] = Math.floor(i * k / n) !== Math.floor((i - 1) * k / n);
        }
      }
      euclidCache.set(key, pat);
      return pat;
    }

    return { SCALES, scale, chordDegrees, yToMidi, snap, isChordTone, isStrongStep,
             velocity, midiToFreq, euclid };
  })();

  // ===== Bus =====
  // voices -> dry + reverbSend -> FDN reverb -> tideFilter -> compressor -> master
  function createBus(ctx) {
    const input = ctx.createGain();          // dry sum (voices connect here)
    const reverbIn = ctx.createGain();       // per-voice sends connect here too
    reverbIn.gain.value = 1;

    // FDN reverb: 4 delays 43/61/79/101ms, feedback 0.65, damping lowpass 3kHz
    const times = [0.043, 0.061, 0.079, 0.101];
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    const delays = times.map(t => {
      const d = ctx.createDelay(0.5); d.delayTime.value = t;
      const fb = ctx.createGain(); fb.gain.value = 0.65;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass'; damp.frequency.value = 3000;
      reverbIn.connect(d);
      d.connect(damp); damp.connect(fb);
      d.connect(wet);
      return { d, fb, damp };
    });
    // cross-feed each line into the next (simple FDN rotation)
    delays.forEach((line, i) => line.fb.connect(delays[(i + 1) % delays.length].d));

    // Tide filter: lowpass 400Hz–12kHz (exp) over tide 0.15–0.85
    const tideFilter = ctx.createBiquadFilter();
    tideFilter.type = 'lowpass';
    tideFilter.frequency.value = 12000;
    tideFilter.Q.value = 0.7;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.knee.value = 12;

    const master = ctx.createGain();
    master.gain.value = 0.85;

    input.connect(tideFilter);
    wet.connect(tideFilter);
    tideFilter.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    function setTideFreq(tide, when, ramp) {
      // exp map of mid-zone tide onto 400..12000
      const t = Math.min(1, Math.max(0,
        (tide - CONST.TIDE_LOW) / (CONST.TIDE_HIGH - CONST.TIDE_LOW)));
      const f = 400 * Math.pow(12000 / 400, t);
      const p = tideFilter.frequency;
      if (ramp && ramp > 0) {
        p.cancelScheduledValues(when);
        p.setValueAtTime(p.value, when);
        p.exponentialRampToValueAtTime(f, when + ramp);
      } else {
        p.setTargetAtTime(f, when || 0, 0.05);
      }
    }

    return { input, reverbIn, tideFilter, comp, master, wet, setTideFreq };
  }

  // ===== Voices =====
  // Bloom (pluck), Drift (pad), Pulse (kick below MIDI 60, hat at/above).
  // playNote schedules one note; active-note tracking enables Drift-first
  // voice stealing at the 12-voice polyphony cap.
  function createVoices(ctx, bus) {
    const active = []; // {voice, gains:[GainNode], startedAt, endTime, nodes:[]}

    function prune() {
      const now = ctx.currentTime;
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].endTime <= now) active.splice(i, 1);
      }
    }

    // Steal to stay under MAX_POLY: oldest Drift first, then oldest Bloom.
    // Pulse is never stolen (priority Pulse > Bloom > Drift).
    function stealIfNeeded(when) {
      prune();
      if (active.length < CONST.MAX_POLY) return;
      for (const family of ['drift', 'bloom']) {
        const victims = active.filter(n => n.voice === family)
                              .sort((a, b) => a.startedAt - b.startedAt);
        if (victims.length) {
          const v = victims[0];
          // fast fade instead of hard cut
          v.gains.forEach(g => {
            g.gain.cancelScheduledValues(when);
            g.gain.setValueAtTime(g.gain.value || 0.001, when);
            g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
          });
          v.endTime = when + 0.06;
          active.splice(active.indexOf(v), 1);
          return;
        }
      }
      // only pulses active: allow the overage (pulses are short)
    }

    // Shared output chain: node -> pan -> {dry -> bus.input, send -> bus.reverbIn}
    function route(node, pan, reverbSend) {
      let out = node;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        node.connect(p); out = p;
      }
      const dry = ctx.createGain(); dry.gain.value = 1;
      const send = ctx.createGain(); send.gain.value = reverbSend;
      out.connect(dry); dry.connect(bus.input);
      out.connect(send); send.connect(bus.reverbIn);
      return [dry, send];
    }

    function cleanup(nodes, oscOrSrc) {
      oscOrSrc.onended = () => nodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
    }

    // --- Bloom: triangle -> amp env (a 3ms, exp decay 0.35s)
    //            -> lowpass env-follow 4kHz -> 1.2kHz, Q1
    function bloom(midi, vel, when, pan, send) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = Theory.midiToFreq(midi);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 1;
      lp.frequency.setValueAtTime(4000, when);
      lp.frequency.exponentialRampToValueAtTime(1200, when + 0.35);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.42 * vel, when + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.35);
      osc.connect(lp); lp.connect(g);
      const outs = route(g, pan, send);
      osc.start(when); osc.stop(when + 0.4);
      cleanup([osc, lp, g, ...outs], osc);
      return { gains: [g], nodes: [osc, lp, g], end: when + 0.4 };
    }

    // --- Drift: 2 saws ±7 cents -> lowpass (600Hz + tide*2k via bus tide is
    //            global; here 900Hz Q0.8 + slow LFO ±200Hz) -> env
    //            attack 0.4s, sustain = 4 step lengths, release 1.2s
    function drift(midi, vel, when, pan, send, stepDur) {
      const f = Theory.midiToFreq(midi);
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
      o1.frequency.value = f; o1.detune.value = 7;
      o2.frequency.value = f; o2.detune.value = -7;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.8;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15;
      const lfoG = ctx.createGain(); lfoG.gain.value = 200;
      lfo.connect(lfoG); lfoG.connect(lp.frequency);
      const g = ctx.createGain();
      const sus = stepDur * 4;
      const lvl = 0.14 * vel;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(lvl, when + 0.4);
      g.gain.setValueAtTime(lvl, when + Math.max(0.4, sus));
      g.gain.exponentialRampToValueAtTime(0.001, when + Math.max(0.4, sus) + 1.2);
      const end = when + Math.max(0.4, sus) + 1.25;
      o1.connect(lp); o2.connect(lp); lp.connect(g);
      const outs = route(g, pan, send);
      o1.start(when); o2.start(when); lfo.start(when);
      o1.stop(end); o2.stop(end); lfo.stop(end);
      cleanup([o1, o2, lfo, lfoG, lp, g, ...outs], o1);
      return { gains: [g], nodes: [o1, o2, lfo, lp, g], end };
    }

    // --- Pulse kick: sine 150 -> 50Hz exp drop over 0.08s, gain decay 0.25s
    function kick(vel, when, pan, send) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(150, when);
      osc.frequency.exponentialRampToValueAtTime(50, when + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.7 * vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
      osc.connect(g);
      const outs = route(g, pan * 0.3, send * 0.5); // kicks stay centered/dry-ish
      osc.start(when); osc.stop(when + 0.3);
      cleanup([osc, g, ...outs], osc);
      return { gains: [g], nodes: [osc, g], end: when + 0.3 };
    }

    // --- Pulse hat: white noise -> highpass 7kHz -> decay 0.05s
    let noiseBuf = null;
    function getNoise() {
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }
    function hat(vel, when, pan, send, decay) {
      const src = ctx.createBufferSource();
      src.buffer = getNoise();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      const g = ctx.createGain();
      const dec = decay || 0.05;
      g.gain.setValueAtTime(0.25 * vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + dec);
      src.connect(hp); hp.connect(g);
      const outs = route(g, pan, send);
      src.start(when); src.stop(when + dec + 0.02);
      cleanup([src, hp, g, ...outs], src);
      return { gains: [g], nodes: [src, hp, g], end: when + dec + 0.02 };
    }

    // Schedule one note. note: {voice, midi, velocity, when, pan, reverbSend, stepDur}
    function playNote(n) {
      stealIfNeeded(n.when);
      let v;
      if (n.voice === 'drift') v = drift(n.midi, n.velocity, n.when, n.pan, n.reverbSend, n.stepDur);
      else if (n.voice === 'pulse') {
        v = n.midi < 60 ? kick(n.velocity, n.when, n.pan, n.reverbSend)
                        : hat(n.velocity, n.when, n.pan, n.reverbSend, n.hatDecay);
      } else v = bloom(n.midi, n.velocity, n.when, n.pan, n.reverbSend);
      active.push({ voice: n.voice, gains: v.gains, startedAt: n.when, endTime: v.end });
    }

    return { playNote, activeCount: () => { prune(); return active.length; } };
  }

  // ===== Scheduler =====
  // 25ms tick, 100ms lookahead against ctx.currentTime. Swing on odd 8ths.
  function createScheduler(ctx, opts) {
    let tempo = 100;          // bpm
    let swing = 0;            // 0..0.6
    let running = false;
    let timer = null;
    let nextStepTime = 0;
    let stepIdx = 0;          // 0..15
    let barIdx = 0;

    let halfTime = false; // low-tide: doubled step duration (set on bar boundary)

    function stepDur() { return (15 / tempo) * (halfTime ? 2 : 1); } // 16th at bpm

    function tick() {
      // After tab sleep / context suspension the clock may be far ahead of
      // nextStepTime; without a clamp we'd burst-schedule every missed step.
      // Skip the missed steps and rejoin cleanly just ahead of now.
      if (nextStepTime < ctx.currentTime - 0.25) {
        nextStepTime = ctx.currentTime + 0.05;
      }
      const horizon = ctx.currentTime + CONST.LOOKAHEAD;
      while (nextStepTime < horizon) {
        // swing: delay odd 8ths (steps 2,6,10,14 => odd 8th positions)
        const odd8th = (stepIdx % 4) === 2;
        const when = nextStepTime + (odd8th ? swing * stepDur() : 0);

        const notes = opts.resolveStep
          ? opts.resolveStep(stepIdx, barIdx, when, stepDur())
          : [];
        if (opts.onStep) opts.onStep(stepIdx, notes);
        if (stepIdx === 0 && opts.onBeat) opts.onBeat(barIdx);

        stepIdx = (stepIdx + 1) % CONST.STEPS;
        if (stepIdx === 0) barIdx++;
        nextStepTime += stepDur();
      }
    }

    return {
      start() {
        if (running) return;
        running = true;
        stepIdx = 0; barIdx = 0;
        nextStepTime = ctx.currentTime + 0.05;
        timer = setInterval(tick, CONST.TICK_MS);
        tick();
      },
      stop() {
        if (!running) return;
        running = false;
        clearInterval(timer); timer = null;
      },
      get running() { return running; },
      get barIdx() { return barIdx; },
      setTempo(bpm) { tempo = Math.min(140, Math.max(60, bpm)); },
      setSwing(s) { swing = Math.min(0.6, Math.max(0, s)); },
      setHalfTime(b) { halfTime = !!b; },
      stepDur,
      getTempo() { return tempo; },
      getSwing() { return swing; }
    };
  }

  // ===== Garden =====
  // Seed model + per-step resolution. Normalized 0–1 coords:
  //   x -> euclid rotation floor(x*16) and stereo pan (-1..1)
  //   y -> pitch (scale lattice, snapped per beat)
  //   distance from center (0.5,0.5) -> reverb send 0.1–0.6
  function createGarden() {
    let nextId = 1;
    const seeds = new Map(); // id -> {x,y,voice,k,probability,muted}

    function makeId() { return 's' + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6); }

    function reverbSend(x, y) {
      // max distance from center is ~0.707; normalize to 0..1
      const d = Math.min(1, Math.hypot(x - 0.5, y - 0.5) / 0.707);
      return 0.1 + d * 0.5;
    }

    function pan(x) { return Math.max(-1, Math.min(1, (x - 0.5) * 2)); }

    // Resolve which seeds fire on this step. Returns note payloads
    // {seedId, voice, midi, velocity, chordTone, strongBeat, when} plus
    // internal fields (pan, reverbSend, stepDur) for the voice layer.
    function resolveStep(stepIdx, barIdx, when, stepDur, musState) {
      const { root, mode } = musState;
      const zone = musState.tideZone || 'mid';
      const tideVel = musState.tideVel == null ? 1 : musState.tideVel;
      const candidates = [];
      seeds.forEach((s, id) => {
        if (s.muted) return;
        const rot = Math.floor(s.x * CONST.STEPS) % CONST.STEPS;
        // Low tide thins Pulse patterns to half density (underwater feel).
        const k = (zone === 'low' && s.voice === 'pulse')
          ? Math.max(1, Math.floor(s.k / 2)) : s.k;
        if (!Theory.euclid(k, CONST.STEPS, rot)[stepIdx]) return;
        if (Math.random() > s.probability) return;
        const raw = Theory.yToMidi(s.y, root, mode, s.mutOff | 0);
        const midi = Theory.snap(raw, root, mode, barIdx, stepIdx);
        const velocity = Theory.velocity(midi, root, mode, barIdx, stepIdx) * tideVel;
        candidates.push({
          seedId: id, voice: s.voice, midi, velocity,
          chordTone: Theory.isChordTone(midi, root, mode, barIdx),
          strongBeat: Theory.isStrongStep(stepIdx),
          when,
          pan: pan(s.x), reverbSend: reverbSend(s.x, s.y), stepDur,
          hatDecay: (zone === 'high') ? 0.02 : undefined
        });
      });
      // Per-step onset cap: probability-weighted culling — keep the most
      // salient (velocity, jittered so ties don't always cull the same seed).
      if (candidates.length > CONST.STEP_ONSETS) {
        candidates.sort((a, b) =>
          (b.velocity + Math.random() * 0.1) - (a.velocity + Math.random() * 0.1));
        candidates.length = CONST.STEP_ONSETS;
      }
      return candidates;
    }

    return { seeds, makeId, resolveStep, reverbSend, pan };
  }

  // ===== Store =====
  // v1 codec, URL-hash-safe (digits and . , ; | - only):
  //   "v1|tempo,swing,root,modeIdx,mutation,tide|x,y,voiceIdx,k,prob,muted;..."
  // Engine assembly owns applying a decoded snapshot (crossfade, onRestore).
  function createStore() {
    const MODES = ['ionian', 'dorian', 'mixolydian', 'aeolian', 'majPent', 'minPent'];
    const VOICE_NAMES = ['bloom', 'drift', 'pulse'];
    const r3 = v => Math.round(v * 1000) / 1000;

    function encode(settings, seedsMap) {
      const s = settings;
      const head = [Math.round(s.tempo * 10) / 10, r3(s.swing), s.root, Math.max(0, MODES.indexOf(s.mode)),
                    r3(s.mutation), r3(s.tide)].join(',');
      const body = [];
      seedsMap.forEach(sd => {
        body.push([r3(sd.x), r3(sd.y), Math.max(0, VOICE_NAMES.indexOf(sd.voice)),
                   sd.k, r3(sd.probability), sd.muted ? 1 : 0].join(','));
      });
      return 'v1|' + head + '|' + body.join(';');
    }

    function decode(str) {
      try {
        if (typeof str !== 'string' || !str.startsWith('v1|')) return null;
        const parts = str.split('|');
        if (parts.length < 3) return null;
        const h = parts[1].split(',').map(Number);
        if (h.length < 6 || h.some(n => !isFinite(n))) return null;
        const settings = {
          tempo: Math.min(140, Math.max(60, h[0])),
          swing: Math.min(0.6, Math.max(0, h[1])),
          root: ((Math.round(h[2]) % 12) + 12) % 12,
          mode: MODES[Math.round(h[3])] || 'ionian',
          mutation: Math.min(1, Math.max(0, h[4])),
          tide: Math.min(1, Math.max(0, h[5]))
        };
        const seeds = [];
        if (parts[2]) {
          for (const chunk of parts[2].split(';')) {
            const f = chunk.split(',').map(Number);
            if (f.length < 6 || f.some(n => !isFinite(n))) continue;
            seeds.push({
              x: Math.min(1, Math.max(0, f[0])),
              y: Math.min(1, Math.max(0, f[1])),
              voice: VOICE_NAMES[Math.round(f[2])] || 'bloom',
              k: Math.min(CONST.STEPS, Math.max(1, Math.round(f[3]))),
              probability: Math.min(1, Math.max(0, f[4])),
              muted: f[5] === 1
            });
            if (seeds.length >= CONST.MAX_SEEDS) break;
          }
        }
        return { settings, seeds };
      } catch (e) { return null; }
    }

    return { encode, decode };
  }

  // ===== engine assembly =====
  window.TideGarden = {
    create(callbacks) {
      callbacks = callbacks || {};
      const cb = {
        onStep: callbacks.onStep || null,
        onBeat: callbacks.onBeat || null,
        onMutate: callbacks.onMutate || null,
        onTideZone: callbacks.onTideZone || null,
        onRestore: callbacks.onRestore || null
      };

      let ctx = null;
      let bus = null, voices = null, scheduler = null;
      const garden = createGarden();
      const store = createStore();

      const state = {
        root: 0,
        mode: 'ionian',
        tide: 0.5,
        mutation: 0,
        tempo: 100,
        swing: 0,
        tideZone: 'mid',   // applied zone (changes only on bar boundary)
        tideVel: 1         // velocity scale from tide (0.6–1.0 in mid zone)
      };
      let pendingZone = null; // zone waiting for the next bar boundary

      function zoneFor(tide) {
        if (tide < CONST.TIDE_LOW) return 'low';
        if (tide > CONST.TIDE_HIGH) return 'high';
        return 'mid';
      }

      // Continuous mid-zone macro: velocity 0.6–1.0 (also eases in extremes).
      function tideVelFor(tide) {
        const t = Math.min(1, Math.max(0,
          (tide - CONST.TIDE_LOW) / (CONST.TIDE_HIGH - CONST.TIDE_LOW)));
        return 0.6 + 0.4 * t;
      }

      // Apply a zone change ON a bar boundary with a one-bar crossfade.
      function applyZone(zone, when, barDur) {
        state.tideZone = zone;
        scheduler.setHalfTime(zone === 'low');
        if (zone === 'low') {
          // filter closes, reverb rises: underwater
          bus.tideFilter.frequency.cancelScheduledValues(when);
          bus.tideFilter.frequency.setValueAtTime(bus.tideFilter.frequency.value, when);
          bus.tideFilter.frequency.exponentialRampToValueAtTime(400, when + barDur);
          bus.wet.gain.setTargetAtTime(1.05, when, barDur / 3);
        } else {
          bus.wet.gain.setTargetAtTime(0.7, when, barDur / 3);
          bus.setTideFreq(state.tide, when, barDur);
        }
        if (cb.onTideZone) cb.onTideZone(zone);
      }

      // Per-bar mutation roll: p = mutation×0.15, pitch drifts ±1 scale degree.
      function mutateBar(when) {
        if (state.mutation <= 0) return;
        const p = state.mutation * 0.15;
        garden.seeds.forEach((s, id) => {
          if (Math.random() >= p) return;
          const delta = Math.random() < 0.5 ? -1 : 1;
          const from = Theory.yToMidi(s.y, state.root, state.mode, s.mutOff | 0);
          s.mutOff = (s.mutOff | 0) + delta;
          const to = Theory.yToMidi(s.y, state.root, state.mode, s.mutOff);
          if (to === from) { s.mutOff -= delta; return; } // clamped at lattice edge
          if (cb.onMutate) cb.onMutate(id, { field: 'pitch', from, to, when });
        });
      }

      function ensureCtx() {
        if (ctx) return ctx;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        bus = createBus(ctx);
        voices = createVoices(ctx, bus);
        scheduler = createScheduler(ctx, {
          onStep: (i, notes) => { if (cb.onStep) cb.onStep(i, notes); },
          onBeat: (bar) => { if (cb.onBeat) cb.onBeat(bar); },
          resolveStep: (stepIdx, barIdx, when, dur) => {
            if (stepIdx === 0) {
              // Bar boundary: apply pending tide zone, roll mutations.
              if (pendingZone && pendingZone !== state.tideZone) {
                applyZone(pendingZone, when, dur * CONST.STEPS);
              }
              pendingZone = null;
              mutateBar(when);
            }
            const resolved = garden.resolveStep(stepIdx, barIdx, when, dur, state);
            resolved.forEach(n => voices.playNote(n));
            // High tide shimmer: Bloom +12 octave echo (half vel, 1/16 late),
            // hats doubled with tight 0.02s decay.
            if (state.tideZone === 'high') {
              resolved.forEach(n => {
                if (n.voice === 'bloom' && n.midi + 12 <= CONST.MIDI_HI + 12) {
                  voices.playNote(Object.assign({}, n, {
                    midi: n.midi + 12, velocity: n.velocity * 0.5, when: n.when + dur
                  }));
                } else if (n.voice === 'pulse' && n.midi >= 60) {
                  voices.playNote(Object.assign({}, n, {
                    velocity: n.velocity * 0.7, when: n.when + dur / 2, hatDecay: 0.02
                  }));
                }
              });
            }
            // Callback payload: contract fields only.
            return resolved.map(n => ({
              seedId: n.seedId, voice: n.voice, midi: n.midi,
              velocity: n.velocity, chordTone: n.chordTone,
              strongBeat: n.strongBeat, when: n.when
            }));
          }
        });
        scheduler.setTempo(state.tempo);
        scheduler.setSwing(state.swing);
        bus.setTideFreq(state.tide, ctx.currentTime, 0);
        return ctx;
      }

      // --- snapshot / restore / hash sync ---
      let hashTimer = null;
      let restoring = false;

      function barDurNow() {
        return scheduler ? scheduler.stepDur() * CONST.STEPS : 2.4;
      }

      function doSnapshot() { return store.encode(state, garden.seeds); }

      // Debounced (2s) location.hash auto-update on any garden/setting change.
      function markDirty() {
        if (restoring) return;
        if (hashTimer) clearTimeout(hashTimer);
        hashTimer = setTimeout(() => {
          hashTimer = null;
          try { history.replaceState(null, '', '#' + doSnapshot()); } catch (e) {}
        }, 2000);
      }

      // Apply decoded snapshot internally. Returns fresh-id seed list for onRestore.
      function applySnapshot(data) {
        const st = data.settings;
        state.tempo = st.tempo; state.swing = st.swing;
        state.root = st.root; state.mode = st.mode;
        state.mutation = st.mutation;
        state.tide = st.tide; state.tideVel = tideVelFor(st.tide);
        const zone = zoneFor(st.tide);
        pendingZone = (zone !== state.tideZone) ? zone : null;
        if (scheduler) { scheduler.setTempo(st.tempo); scheduler.setSwing(st.swing); }
        garden.seeds.clear();
        const list = [];
        data.seeds.forEach(sd => {
          const id = garden.makeId();
          garden.seeds.set(id, {
            x: sd.x, y: sd.y, voice: sd.voice, k: sd.k,
            probability: sd.probability, muted: sd.muted, mutOff: 0
          });
          list.push({ id, x: sd.x, y: sd.y, voice: sd.voice, k: sd.k,
                      probability: sd.probability, muted: sd.muted });
        });
        return list;
      }

      // Restore with a one-bar musical crossfade when audible: master ramps
      // out over the first half bar, garden+settings swap at the midpoint,
      // master ramps back while tide/filter glide to the restored values.
      function doRestore(str) {
        const data = store.decode(str);
        if (!data) return false;
        restoring = true;
        const finish = () => {
          const seeds = applySnapshot(data);
          if (bus) bus.setTideFreq(state.tide, ctx.currentTime, barDurNow() / 2);
          restoring = false;
          if (cb.onRestore) cb.onRestore(seeds, Object.assign({}, data.settings));
        };
        if (ctx && ctx.state === 'running' && scheduler && scheduler.running) {
          const bar = barDurNow();
          const t = ctx.currentTime;
          const g = bus.master.gain;
          g.cancelScheduledValues(t);
          g.setValueAtTime(Math.max(0.03, g.value || 0.85), t);
          g.exponentialRampToValueAtTime(0.03, t + bar / 2);
          g.setValueAtTime(0.03, t + bar / 2);
          g.exponentialRampToValueAtTime(0.85, t + bar);
          setTimeout(finish, (bar / 2) * 1000);
        } else {
          finish(); // silent (pre-unlock or stopped): instant apply
        }
        return true;
      }

      // Audio unlock on first gesture: veil click/tap/keydown resumes context.
      function unlock() {
        const c = ensureCtx();
        if (c.state === 'suspended') c.resume();
      }
      const veil = document.getElementById('start-veil');
      if (veil) {
        const onUnlock = () => {
          unlock();
          veil.hidden = true;
          engine.start();
        };
        veil.addEventListener('pointerdown', onUnlock, { once: true });
        veil.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') onUnlock();
        }, { once: true });
      }
      // Safety: resume on any first document gesture (mobile Safari quirk)
      document.addEventListener('pointerdown', () => {
        if (ctx && ctx.state === 'suspended') ctx.resume();
      });

      // Tab sleep: suspend audio while hidden (battery + avoids throttled-timer
      // weirdness), resume on return. The scheduler's nextStepTime clamp makes
      // the rejoin glitch-free — no burst of missed steps.
      let suspendedByVis = false;
      document.addEventListener('visibilitychange', () => {
        if (!ctx) return;
        if (document.hidden) {
          if (ctx.state === 'running' && scheduler && scheduler.running) {
            suspendedByVis = true;
            ctx.suspend();
          }
        } else if (suspendedByVis) {
          suspendedByVis = false;
          ctx.resume();
        }
      });

      const engine = {
        // --- transport / params (functional) ---
        start() { ensureCtx(); if (ctx.state === 'suspended') ctx.resume(); scheduler.start(); },
        stop() { if (scheduler) scheduler.stop(); },
        setTempo(bpm) { state.tempo = bpm; if (scheduler) scheduler.setTempo(bpm); markDirty(); },
        setSwing(s) { state.swing = s; if (scheduler) scheduler.setSwing(s); markDirty(); },
        setTide(v) {
          state.tide = Math.min(1, Math.max(0, v));
          state.tideVel = tideVelFor(state.tide);
          const zone = zoneFor(state.tide);
          if (zone !== state.tideZone) {
            pendingZone = zone; // applied on next bar boundary (crossfaded)
          } else {
            pendingZone = null;
            // continuous mid-zone sweep tracks the finger immediately
            if (bus && state.tideZone === 'mid') {
              bus.setTideFreq(state.tide, ctx.currentTime, 0);
            }
          }
          markDirty();
        },
        setRoot(r) { state.root = ((r % 12) + 12) % 12; markDirty(); },
        setMode(m) { if (Theory.SCALES[m]) state.mode = m; markDirty(); },
        setMutation(v) { state.mutation = Math.min(1, Math.max(0, v)); markDirty(); },
        now() { return ctx ? ctx.currentTime : 0; },

        // --- garden ---
        plant(opts) {
          if (garden.seeds.size >= CONST.MAX_SEEDS) return null;
          const id = garden.makeId();
          garden.seeds.set(id, {
            x: opts.x, y: opts.y, voice: opts.voice || 'bloom',
            k: 5, probability: 1, muted: false, mutOff: 0
          });
          markDirty();
          return id;
        },
        move(id, x, y) {
          const s = garden.seeds.get(id);
          if (s) { s.x = x; s.y = y; markDirty(); }
        },
        setDensity(id, k) {
          const s = garden.seeds.get(id);
          if (s) { s.k = Math.min(CONST.STEPS, Math.max(1, Math.round(k))); markDirty(); }
        },
        setProbability(id, p) {
          const s = garden.seeds.get(id);
          if (s) { s.probability = Math.min(1, Math.max(0, p)); markDirty(); }
        },
        mute(id, b) { const s = garden.seeds.get(id); if (s) { s.muted = !!b; markDirty(); } },
        remove(id) { if (garden.seeds.delete(id)) markDirty(); },
        // Audible retune preview while dragging: seed's own voice through the
        // master bus (tide filter applies), reverb send fixed low (0.15) so
        // drags don't wash out, velocity capped at 0.7.
        previewPluck(id) {
          const s = garden.seeds.get(id);
          if (!s || !ctx || ctx.state !== 'running') return;
          const barIdx = scheduler ? scheduler.barIdx : 0;
          const raw = Theory.yToMidi(s.y, state.root, state.mode, s.mutOff | 0);
          const midi = Theory.snap(raw, state.root, state.mode, barIdx, 0);
          voices.playNote({
            seedId: id, voice: s.voice, midi,
            velocity: Math.min(0.7, state.tideVel),
            when: ctx.currentTime + 0.005,
            pan: garden.pan(s.x), reverbSend: 0.15,
            stepDur: scheduler ? scheduler.stepDur() : 0.15
          });
        },

        // Chord-tone midis (48–83) for a given bar under current root/mode —
        // for the UI's shimmer bands (replaces _debug.Theory reliance).
        chordBandMidis(barIdx) {
          const sc = Theory.scale(state.mode);
          const pcs = Theory.chordDegrees(state.mode, barIdx)
            .map(d => (state.root + sc[d]) % 12);
          const out = [];
          for (let m = CONST.MIDI_LO; m <= CONST.MIDI_HI; m++) {
            if (pcs.includes(m % 12)) out.push(m);
          }
          return out;
        },

        // --- state ---
        snapshot() { return doSnapshot(); },
        restore(str) { return doRestore(str); },

        // internals exposed read-only for debugging during build
        _debug: { CONST, PALETTE, Theory, state, garden }
      };

      // Hash auto-load: parse location.hash on create. Deferred a tick so the
      // caller has wired its UI before onRestore fires; sounding is naturally
      // deferred until unlock (no AudioContext yet => silent instant apply).
      try {
        const h = decodeURIComponent(location.hash.slice(1));
        if (h.startsWith('v1|')) setTimeout(() => doRestore(h), 0);
      } catch (e) {}

      return engine;
    },
    CONST, PALETTE
  };

  // ===== Input =====
  // Pointer state machine: IDLE -> PRESSED -> (DRAG | RADIAL | TAP/DTAP).
  // Single primary pointer for now; a second pointer safely resets (2-finger
  // tide gesture lands in round 6). RADIAL is a logging stub until round 8.
  function createInput(canvas, ui) {
    const S = { mode: 'idle', pid: null, sx: 0, sy: 0, st: 0,
                x: 0, y: 0, px: 0, py: 0, pt: 0, vx: 0, vy: 0,
                seedId: null, holdTimer: null,
                tapSeedId: null, tapTimer: null };

    function reset() {
      if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
      if (S.mode === 'radial') ui.radial.cancel();  // no commit on cancel
      S.mode = 'idle'; S.pid = null; S.seedId = null;
      ui.setDragging(false);
    }

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function hitSeed(x, y) {
      let best = null, bestD = CONST.HIT_RADIUS;
      ui.sprites.forEach((s, id) => {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= bestD) { bestD = d; best = id; }
      });
      return best;
    }

    function down(e) {
      // Whole-screen tide gesture: right-button drag, or a second finger
      // landing during any touch gesture (cancels it, becomes tide).
      if (e.button === 2 || S.mode !== 'idle') {
        if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
        ui.setDragging(false);
        S.mode = 'tide'; S.pid = e.pointerId; S.seedId = null;
        S.py = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const p = pos(e);
      S.mode = 'pressed'; S.pid = e.pointerId;
      S.sx = S.px = S.x = p.x; S.sy = S.py = S.y = p.y;
      S.st = S.pt = performance.now();
      S.vx = S.vy = 0;
      S.seedId = hitSeed(p.x, p.y);
      canvas.setPointerCapture(e.pointerId);
      if (S.seedId) {
        S.holdTimer = setTimeout(() => {
          if (S.mode === 'pressed') {
            S.mode = 'radial';
            ui.radial.open(S.seedId);
          }
        }, CONST.HOLD_MS);
      }
    }

    function move(e) {
      if (e.pointerId !== S.pid || S.mode === 'idle') return;
      if (S.mode === 'tide') {
        const dy = S.py - e.clientY;   // drag up = tide rises
        S.py = e.clientY;
        ui.nudgeTide(dy / (window.innerHeight * 0.6));
        return;
      }
      const p = pos(e);
      const now = performance.now();
      const dt = Math.max(1, now - S.pt);
      S.vx = (p.x - S.px) / dt * 1000; S.vy = (p.y - S.py) / dt * 1000;
      S.px = S.x; S.py = S.y; S.pt = now;
      S.x = p.x; S.y = p.y;

      if (S.mode === 'pressed' &&
          Math.hypot(p.x - S.sx, p.y - S.sy) > CONST.DRAG_THRESH) {
        if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
        S.mode = 'drag';
        if (S.seedId) ui.setDragging(true);
      }
      if (S.mode === 'drag' && S.seedId) {
        ui.moveSeed(S.seedId, p.x, p.y, Math.hypot(S.vx, S.vy));
      }
      if (S.mode === 'radial') ui.radial.drag(p.x, p.y);
    }

    function up(e) {
      if (e.pointerId !== S.pid || S.mode === 'idle') return;
      if (S.mode === 'tide') { reset(); return; }
      if (S.mode === 'radial') { ui.radial.end(); reset(); return; }
      const now = performance.now();
      const speed = Math.hypot(S.vx, S.vy);

      if (S.mode === 'drag' && S.seedId && speed > CONST.FLING) {
        ui.uprootSeed(S.seedId);                       // fling = uproot
      } else if (S.mode === 'drag' && S.seedId) {
        ui.endDrag(S.seedId);                          // confirming pluck
      } else if (S.mode === 'pressed' && now - S.st < CONST.DTAP_MS) {
        if (!S.seedId) {
          ui.plantAt(S.x, S.y);                        // planting never lags
        } else if (S.tapSeedId === S.seedId && S.tapTimer) {
          clearTimeout(S.tapTimer); S.tapTimer = null; S.tapSeedId = null;
          ui.toggleMute(S.seedId);                     // double-tap = mute
        } else {
          if (S.tapTimer) clearTimeout(S.tapTimer);
          S.tapSeedId = S.seedId;
          S.tapTimer = setTimeout(() => {
            S.tapTimer = null; S.tapSeedId = null;     // single tap = select
          }, CONST.DTAP_MS);
        }
      }
      reset();
    }

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', reset);
    window.addEventListener('blur', reset);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      ui.nudgeTide(-e.deltaY * 0.0006);   // wheel up = tide rises
    }, { passive: false });

    return { state: S, reset };
  }

  // ===== Renderer =====
  // rAF loop, DPR-scaled canvas, tide gradient, breathing rings (6s cycle),
  // fixed draw order. Skips frames when tab hidden or veil is up.
  function createRenderer(canvas, ui) {
    const c2d = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    let running = false;
    let lastStepFlash = { t: -1, idx: 0 };

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resize);
    resize();

    // Tide-zone visual grammar: -1 low (dark, sunken) .. 0 mid .. 1 high
    // (lighter, floating). Lerped over ~one bar to track the audio crossfade.
    let tideMix = 0;
    function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
    const RGB_BG = hex(PALETTE.bg), RGB_LOW = hex(PALETTE.bgLow),
          RGB_HIGH = hex(PALETTE.bgHigh), RGB_TOP = hex('#1B3A5C');
    function mix(a, b, t) {
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
        Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
        Math.round(a[2] + (b[2] - a[2]) * t) + ')';
    }

    function drawBackground() {
      const target = ui.tideZone === 'low' ? -1 : ui.tideZone === 'high' ? 1 : 0;
      const rate = 1 / (60 * (ui.barSec || 2.4));   // ~one bar at 60fps
      tideMix += Math.max(-rate, Math.min(rate, target - tideMix));
      const m = tideMix;
      const bottom = m < 0 ? mix(RGB_BG, RGB_LOW, -m) : mix(RGB_BG, RGB_HIGH, m);
      const top = m < 0 ? mix(RGB_HIGH, RGB_LOW, -m) : mix(RGB_HIGH, RGB_TOP, m);
      const g = c2d.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);
      c2d.fillStyle = g;
      c2d.fillRect(0, 0, W, H);
    }
    function seedDY() { return -4 * tideMix; } // low: sink +4px, high: float -4px

    // Concentric tide rings breathing on a 6s cycle (reverb-depth hint).
    function drawRings(tSec) {
      const cx = W / 2, cy = H / 2;
      const maxR = Math.hypot(cx, cy);
      const breathe = 0.5 + 0.5 * Math.sin(tSec * Math.PI * 2 / 6); // 6s
      c2d.strokeStyle = PALETTE.text;
      for (let i = 1; i <= 5; i++) {
        const r = (i / 5) * maxR * (0.96 + 0.04 * breathe);
        c2d.globalAlpha = 0.035 + 0.03 * breathe * (1 - i / 6);
        c2d.beginPath();
        c2d.arc(cx, cy, r, 0, Math.PI * 2);
        c2d.stroke();
      }
      c2d.globalAlpha = 1;
    }

    // Chord-band shimmer: soft horizontal bands at chord-tone pitch heights,
    // fading in while dragging a seed and out on release.
    let shimA = 0;
    function drawShimmer() {
      const target = ui.dragging ? 1 : 0;
      shimA += (target - shimA) * 0.12;
      if (shimA < 0.01 || !ui.chordBandYs) { if (shimA < 0.01) shimA = 0; return; }
      const ys = ui.chordBandYs(H);
      c2d.fillStyle = PALETTE.text;
      for (let i = 0; i < ys.length; i++) {
        const y = ys[i];
        c2d.globalAlpha = 0.05 * shimA;
        c2d.fillRect(0, y - 8, W, 16);          // soft body
        c2d.globalAlpha = 0.12 * shimA;
        c2d.fillRect(0, y - 1, W, 2);           // bright center line
      }
      c2d.globalAlpha = 1;
    }

    function drawSeeds(tSec) {
      const dy = seedDY();
      const radialActive = ui.radial ? ui.radial.state.active : null;
      c2d.save();
      c2d.translate(0, dy);
      ui.sprites.forEach((s, id) => {
        const col = PALETTE[s.voice] || PALETTE.bloom;
        // radial open: others dim 40%; garden-full: everyone pulses once
        const dim = (radialActive && id !== radialActive) ? 0.6 : 1;
        c2d.fillStyle = col;
        c2d.strokeStyle = col;
        if (s.muted) {
          // mute silhouette: dim outline only, no fill
          c2d.globalAlpha = 0.35 * dim;
          c2d.lineWidth = 1.5;
          c2d.beginPath();
          c2d.arc(s.x, s.y, 6, 0, Math.PI * 2);
          c2d.stroke();
        } else {
          // soft halo
          c2d.globalAlpha = 0.18 * dim;
          c2d.beginPath();
          c2d.arc(s.x, s.y, 14, 0, Math.PI * 2);
          c2d.fill();
          // core dot: step pulse, plus the one-shot garden-full pulse
          const pulse = ((tSec - lastStepFlash.t) < 0.15 ||
                         (tSec - (ui.pulseT || -9)) < 0.3) ? 1.5 : 0;
          c2d.globalAlpha = 1 * dim;
          c2d.beginPath();
          c2d.arc(s.x, s.y, 6 + pulse, 0, Math.PI * 2);
          c2d.fill();
        }
        // k-dot density ring (shown for muted seeds too, dimmer)
        const k = s.k || 5;
        c2d.globalAlpha = (s.muted ? 0.25 : 0.75) * dim;
        for (let i = 0; i < k; i++) {
          const a = -Math.PI / 2 + (Math.PI * 2 * i) / k;
          c2d.beginPath();
          c2d.arc(s.x + Math.cos(a) * 12, s.y + Math.sin(a) * 12, 1.6, 0, Math.PI * 2);
          c2d.fill();
        }
      });
      c2d.restore();
      c2d.globalAlpha = 1;
      c2d.lineWidth = 1;
    }

    // Radial menu overlay: 160ms spring bloom, detent ring, probability arc.
    function drawRadial() {
      if (!ui.radial) return;
      const R = ui.radial.state;
      if (!R.active) return;
      const t = (performance.now() - R.openT) / 160;
      const sc = t >= 1 ? 1 : 1.15 * (1 - Math.pow(1 - Math.min(1, t), 2)); // slight overshoot
      const rad = 44 * Math.min(sc, 1.08);
      c2d.strokeStyle = PALETTE.text;
      c2d.globalAlpha = 0.5;
      c2d.lineWidth = 1;
      c2d.beginPath();
      c2d.arc(R.cx, R.cy, rad, 0, Math.PI * 2);
      c2d.stroke();
      // probability arc: clockwise from 9 o'clock, brightness = probability
      const frac = (R.prob - 0.3) / 0.7;
      c2d.globalAlpha = 0.25 + 0.65 * frac;
      c2d.lineWidth = 3;
      c2d.beginPath();
      c2d.arc(R.cx, R.cy, rad + 6, Math.PI, Math.PI + frac * Math.PI * 2);
      c2d.stroke();
      // k detent dots filling with density
      const DET = [1, 2, 3, 5, 7, 9, 11, 13];
      const ki = DET.indexOf(R.k);
      c2d.fillStyle = PALETTE.text;
      for (let i = 0; i < DET.length; i++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * i) / DET.length;
        c2d.globalAlpha = i <= ki ? 0.9 : 0.25;
        c2d.beginPath();
        c2d.arc(R.cx + Math.cos(a) * (rad - 8), R.cy + Math.sin(a) * (rad - 8),
                i <= ki ? 2.5 : 1.5, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.globalAlpha = 1;
      c2d.lineWidth = 1;
    }

    // Keyboard cursor: dashed ring at the lattice position.
    function drawCursor(tSec) {
      if (!ui.cursor) return;
      const p = ui.cursor.pos();
      if (!p) return;
      c2d.strokeStyle = PALETTE.text;
      c2d.globalAlpha = 0.85;
      c2d.lineWidth = 1.5;
      c2d.setLineDash([4, 4]);
      c2d.lineDashOffset = -(tSec * 12) % 8;   // slow crawl = alive
      c2d.beginPath();
      c2d.arc(p.x, p.y, 16, 0, Math.PI * 2);
      c2d.stroke();
      c2d.setLineDash([]);
      c2d.globalAlpha = 1;
      c2d.lineWidth = 1;
    }

    function frame() {
      if (!running) return;
      if (!document.hidden && !ui.veilUp()) {
        const tSec = performance.now() / 1000;
        drawBackground();          // 1. tide gradient
        drawRings(tSec);           // 2. breathing rings
        drawShimmer();             // 3. chord-band shimmer (drag only)
        drawSeeds(tSec);           // 4. seeds
        if (ui.fx) ui.fx.draw(c2d, ui.now ? ui.now() : 0); // 5. ripples/petals
        drawRadial();              // 6. radial menu overlay
        drawCursor(tSec);          // 7. keyboard cursor
      }
      requestAnimationFrame(frame);
    }

    return {
      start() { if (!running) { running = true; requestAnimationFrame(frame); } },
      stepFlash(idx) { lastStepFlash = { t: performance.now() / 1000, idx }; },
      get size() { return { W, H }; }
    };
  }

  // ===== FX =====
  // Preallocated pools, zero allocation in the draw loop. Ripples fire at the
  // note's audio `when` (compared against engine.now()), size ∝ velocity,
  // brighter when chordTone, colored by voice. Petal-scatter for uproot.
  function createFX(ui) {
    const RIPPLES = 64, PETALS = 48;
    const R = [];
    for (let i = 0; i < RIPPLES; i++) {
      R.push({ on: false, x: 0, y: 0, when: 0, vel: 0, ct: false, color: PALETTE.bloom });
    }
    let ri = 0;
    const P = [];
    for (let i = 0; i < PETALS; i++) {
      P.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t0: 0, color: PALETTE.bloom });
    }
    let pi = 0;
    const SPARKS = 32;
    const K = [];
    for (let i = 0; i < SPARKS; i++) K.push({ on: false, x: 0, y: 0, when: 0 });
    let ki = 0;

    // Mutation sparkle: brief 4-point star at the seed, fires at audio `when`.
    function sparkle(x, y, when) {
      const s = K[ki]; ki = (ki + 1) % SPARKS;
      s.on = true; s.x = x; s.y = y; s.when = when;
    }

    // Generic expanding ring (also used for the garden-full feedback).
    function ringAt(x, y, when, color, vel, ct) {
      const r = R[ri]; ri = (ri + 1) % RIPPLES;
      r.on = true; r.x = x; r.y = y;
      r.when = when; r.vel = vel; r.ct = !!ct; r.color = color;
    }

    function ripple(note) {
      const s = ui.sprites.get(note.seedId);
      if (!s) return;
      ringAt(s.x, s.y, note.when, PALETTE[note.voice] || PALETTE.bloom,
             note.velocity, note.chordTone);
    }

    function scatter(x, y, color) {
      for (let k = 0; k < 8; k++) {
        const p = P[pi]; pi = (pi + 1) % PETALS;
        p.on = true; p.x = x; p.y = y;
        const a = (Math.PI * 2 * k) / 8 + Math.random() * 0.5;
        const sp = 60 + Math.random() * 90;
        p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
        p.t0 = performance.now() / 1000; p.color = color;
      }
    }

    function draw(c2d, audioNow) {
      const tNow = performance.now() / 1000;
      // Half-time low tide: ripple expansion speed halves (motion IS the tempo)
      const life = ui.tideZone === 'low' ? 1.2 : 0.6;
      const high = ui.tideZone === 'high';
      for (let i = 0; i < RIPPLES; i++) {
        const r = R[i];
        if (!r.on) continue;
        const prog = (audioNow - r.when) / life;
        if (prog < 0) continue;                   // scheduled, not yet heard
        if (prog >= 1) { r.on = false; continue; }
        const e = 1 - Math.pow(1 - prog, 3);      // ease-out
        const rad = 10 + e * (24 + 46 * r.vel);
        c2d.globalAlpha = (1 - e) * (r.ct ? 0.85 : 0.45);
        c2d.strokeStyle = r.color;
        c2d.lineWidth = r.ct ? 2.5 : 1.5;
        c2d.beginPath();
        c2d.arc(r.x, r.y, rad, 0, Math.PI * 2);
        c2d.stroke();
        if (high) {
          // shimmer zone: tiny secondary sparkle ring trailing the main one
          c2d.globalAlpha = (1 - e) * 0.35;
          c2d.lineWidth = 1;
          c2d.beginPath();
          c2d.arc(r.x, r.y, rad * 1.35, 0, Math.PI * 2);
          c2d.stroke();
        }
      }
      c2d.lineWidth = 1;
      for (let i = 0; i < SPARKS; i++) {
        const s = K[i];
        if (!s.on) continue;
        const prog = (audioNow - s.when) / 0.5;
        if (prog < 0) continue;
        if (prog >= 1) { s.on = false; continue; }
        const a = 1 - prog;
        const len = 4 + 8 * (1 - Math.pow(1 - prog, 2));
        c2d.globalAlpha = a;
        c2d.strokeStyle = PALETTE.text;
        c2d.beginPath();
        c2d.moveTo(s.x - len, s.y); c2d.lineTo(s.x + len, s.y);
        c2d.moveTo(s.x, s.y - len); c2d.lineTo(s.x, s.y + len);
        c2d.stroke();
      }
      for (let i = 0; i < PETALS; i++) {
        const p = P[i];
        if (!p.on) continue;
        const dt = tNow - p.t0;
        if (dt >= 0.35) { p.on = false; continue; }
        const f = dt / 0.35;
        c2d.globalAlpha = 1 - f;
        c2d.fillStyle = p.color;
        c2d.beginPath();
        c2d.arc(p.x + p.vx * dt, p.y + p.vy * dt, 3 * (1 - f) + 1, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.globalAlpha = 1;
    }

    return { ripple, ringAt, scatter, sparkle, draw };
  }

  // ===== Radial =====
  // Press-hold radial menu: distance = density (euclid k, detents), angle =
  // probability 0.3–1.0 clockwise from 9 o'clock. Drawn on the canvas by the
  // Renderer (single render path); this module owns state + math + commit.
  function createRadial(ui, engine) {
    const DETENTS = [1, 2, 3, 5, 7, 9, 11, 13];
    const R = {
      active: null,   // seed id while open
      cx: 0, cy: 0,   // seed center (px)
      k: 5, prob: 1,  // live values (previewed on the sprite)
      openT: 0,       // for the 160ms spring bloom
      origK: 5, origProb: 1
    };

    function open(id) {
      const s = ui.sprites.get(id);
      if (!s) return;
      R.active = id; R.cx = s.x; R.cy = s.y;
      R.k = R.origK = s.k || 5;
      R.prob = R.origProb = (s.prob == null ? 1 : s.prob);
      R.openT = performance.now();
    }

    function drag(x, y) {
      if (!R.active) return;
      const s = ui.sprites.get(R.active);
      if (!s) { R.active = null; return; }
      const dx = x - R.cx, dy = y - R.cy;
      const dist = Math.hypot(dx, dy);
      if (dist > 28) {
        // distance -> density detents
        const idx = Math.min(DETENTS.length - 1, Math.floor((dist - 28) / 14));
        R.k = DETENTS[idx];
        // angle -> probability, clockwise from 9 o'clock (screen coords)
        const a = Math.atan2(dy, dx);                       // 0 right, pi left
        const frac = ((a - Math.PI) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
        R.prob = 0.3 + 0.7 * frac;
      }
      s.k = R.k; s.prob = R.prob;   // live k-dot ring preview
    }

    function end() {                // release commits
      if (!R.active) return;
      engine.setDensity(R.active, R.k);
      engine.setProbability(R.active, R.prob);
      engine.previewPluck(R.active);
      R.active = null;
    }

    function cancel() {             // pointercancel: revert preview
      if (!R.active) return;
      const s = ui.sprites.get(R.active);
      if (s) { s.k = R.origK; s.prob = R.origProb; }
      R.active = null;
    }

    return { state: R, open, drag, end, cancel };
  }

  // ===== Dock =====
  // Real controls wired to the engine, plus the tide rail (accessible tide).
  function createDock(ui, engine) {
    const $ = (id) => document.getElementById(id);
    const play = $('play'), brush = $('brush'), root = $('root'), mode = $('mode');
    const dock = $('dock'), toggle = $('dock-toggle'), rail = $('tide-rail');

    // --- root / mode selects ---
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    NOTES.forEach((n, i) => root.add(new Option(n, i)));
    [['ionian', 'ionian (major)'], ['dorian', 'dorian'], ['mixolydian', 'mixolydian'],
     ['aeolian', 'aeolian (minor)'], ['majPent', 'major penta'], ['minPent', 'minor penta']]
      .forEach(([v, l]) => mode.add(new Option(l, v)));
    root.addEventListener('change', () => {
      ui.music.root = +root.value; engine.setRoot(+root.value);
    });
    mode.addEventListener('change', () => {
      ui.music.mode = mode.value; engine.setMode(mode.value);
    });

    // --- play / pause ---
    let playing = true;
    play.addEventListener('click', () => {
      playing = !playing;
      if (playing) engine.start(); else engine.stop();
      play.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      play.setAttribute('aria-pressed', String(playing));
    });

    // --- voice brush cycle ---
    const VOICES = ['bloom', 'drift', 'pulse'];
    function setBrush(v) {
      ui.brush = v;
      brush.innerHTML = '<span class="swatch" style="background:' +
        PALETTE[v] + '"></span>' + v;
      brush.setAttribute('aria-label', 'Seed voice: ' + v);
    }
    brush.addEventListener('click', () => {
      setBrush(VOICES[(VOICES.indexOf(ui.brush) + 1) % VOICES.length]);
    });
    setBrush(ui.brush);

    // --- ranges with data-fmt labels ---
    const ranges = {};
    function wireRange(id, apply) {
      const el = $(id);
      const out = el.parentElement.querySelector('output');
      const fmt = el.getAttribute('data-fmt') || '';
      const update = () => {
        out.textContent = el.value + (fmt === '%' ? '%' : ' ' + fmt);
        apply(+el.value);
      };
      el.addEventListener('input', update);
      update();
      ranges[id] = { el, update };
    }
    wireRange('tempo', (v) => { engine.setTempo(v); ui.barSec = (16 * 15) / v; });
    wireRange('swing', (v) => engine.setSwing(v / 100));
    wireRange('mutation', (v) => engine.setMutation(v / 100));

    // --- share: hash + copy link, morphs to confirmation ---
    const share = $('share');
    share.addEventListener('click', () => {
      try { history.replaceState(null, '', '#' + engine.snapshot()); } catch (e) {}
      const url = location.href;
      const done = () => {
        share.textContent = '✓ copied';
        setTimeout(() => { share.textContent = 'share'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => {
          window.prompt('Copy your garden link:', url);
        });
      } else {
        window.prompt('Copy your garden link:', url);
      }
    });

    // --- collapse chevron ---
    toggle.addEventListener('click', () => {
      const collapsed = dock.classList.toggle('collapsed');
      toggle.innerHTML = collapsed ? '&#9652;' : '&#9662;';
      toggle.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });

    // --- tide rail: draggable + keyboard slider ---
    const fill = rail.querySelector('.fill');
    function showTide(v) {
      fill.style.height = Math.round(v * 100) + '%';
      rail.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    }
    function railTideFromEvent(e) {
      const r = rail.getBoundingClientRect();
      ui.setTide(1 - (e.clientY - r.top) / r.height);
    }
    let railDrag = false;
    rail.addEventListener('pointerdown', (e) => {
      railDrag = true; rail.setPointerCapture(e.pointerId); railTideFromEvent(e);
    });
    rail.addEventListener('pointermove', (e) => { if (railDrag) railTideFromEvent(e); });
    rail.addEventListener('pointerup', () => { railDrag = false; });
    rail.addEventListener('pointercancel', () => { railDrag = false; });
    rail.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.15 : 0.05;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        ui.setTide(ui.tide + step); e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        ui.setTide(ui.tide - step); e.preventDefault();
      }
    });
    showTide(ui.tide);

    // Resync every control after a snapshot restore (engine already applied
    // the settings — this only refreshes the UI, setters echo same values).
    function sync(st) {
      root.value = String(st.root);
      mode.value = st.mode;
      ui.music.root = st.root;
      ui.music.mode = st.mode;
      ranges.tempo.el.value = String(st.tempo); ranges.tempo.update();
      ranges.swing.el.value = String(Math.round(st.swing * 100)); ranges.swing.update();
      ranges.mutation.el.value = String(Math.round(st.mutation * 100)); ranges.mutation.update();
      ui.tide = st.tide;
      showTide(st.tide);
    }

    return { showTide, sync };
  }

  // ===== Cursor =====
  // Keyboard mode: dashed-ring cursor on the scale lattice. Arrows move
  // (up/down = scale degree, left/right = 1/16 x-step; shift = octave / 4
  // steps), Enter plants, Delete uproots, M mutes, [ ] density, ; ' prob.
  function createCursor(ui, engine) {
    const C = { on: false, xs: 8, idx: 10 };  // x step 0..15, lattice index

    function scaleLen() {
      return (ui.uiScales[ui.music.mode] || ui.uiScales.ionian).length;
    }
    function span() { return scaleLen() * 3; }
    function px() { return { x: (C.xs + 0.5) / CONST.STEPS * window.innerWidth,
                             y: (1 - C.idx / (span() - 1)) * window.innerHeight }; }
    function seedUnder() {
      const p = px();
      let best = null, bestD = CONST.HIT_RADIUS;
      ui.sprites.forEach((s, id) => {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d <= bestD) { bestD = d; best = id; }
      });
      return best;
    }
    function pos() { return C.on ? px() : null; }

    function isFormTarget(e) {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                   t.tagName === 'BUTTON' || t.id === 'tide-rail' ||
                   t.id === 'start-veil');
    }

    window.addEventListener('keydown', (e) => {
      if (isFormTarget(e) || ui.veilUp()) return;
      const key = e.key;
      const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (arrows.includes(key)) {
        e.preventDefault();
        if (!C.on) { C.on = true; return; }  // first arrow just reveals cursor
        const big = e.shiftKey;
        if (key === 'ArrowUp')    C.idx = Math.min(span() - 1, C.idx + (big ? scaleLen() : 1));
        if (key === 'ArrowDown')  C.idx = Math.max(0, C.idx - (big ? scaleLen() : 1));
        if (key === 'ArrowRight') C.xs = (C.xs + (big ? 4 : 1)) % CONST.STEPS;
        if (key === 'ArrowLeft')  C.xs = (C.xs - (big ? 4 : 1) + CONST.STEPS) % CONST.STEPS;
        return;
      }
      if (!C.on) return;
      if (key === 'Escape') { C.on = false; return; }
      const p = px();
      const id = seedUnder();
      if (key === 'Enter') {
        if (!id) ui.plantAt(p.x, p.y);
        return e.preventDefault();
      }
      if (!id) return;
      const s = ui.sprites.get(id);
      if (key === 'Delete' || key === 'Backspace') {
        ui.uprootSeed(id); e.preventDefault();
      } else if (key === 'm' || key === 'M') {
        ui.toggleMute(id);
      } else if (key === '[' || key === ']') {
        const D = [1, 2, 3, 5, 7, 9, 11, 13];
        let di = D.indexOf(s.k); if (di < 0) di = 3;
        di = Math.max(0, Math.min(D.length - 1, di + (key === ']' ? 1 : -1)));
        s.k = D[di];
        engine.setDensity(id, s.k);
        engine.previewPluck(id);
      } else if (key === ';' || key === "'") {
        const p0 = s.prob == null ? 1 : s.prob;
        s.prob = Math.max(0.3, Math.min(1, p0 + (key === "'" ? 0.1 : -0.1)));
        engine.setProbability(id, s.prob);
        engine.previewPluck(id);
      }
    });

    return { state: C, pos };
  }

  // ===== boot =====
  (function boot() {
    const canvas = document.getElementById('water');
    const veil = document.getElementById('start-veil');
    if (!canvas) return;

    // UI-side sprite registry + shared helpers for Input/Renderer/FX.
    // Preview-pluck gate state (per active drag).
    const pluckGate = { lastT: 0, lastMidi: -1 };

    // UI-side scale intervals (mirror of engine tables) — lets the UI invert
    // midi -> lattice y without reaching into engine internals.
    const UI_SCALES = {
      ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
      mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
      majPent: [0, 2, 4, 7, 9], minPent: [0, 3, 5, 7, 10]
    };

    const ui = {
      sprites: new Map(),   // engineId -> {x, y, voice, muted, k}
      brush: 'bloom',       // cycled by dock
      music: { root: 0, mode: 'ionian' },  // dock-owned copy for band math
      dragging: false,
      barIdx: 0,            // tracked from onBeat, drives chord bands
      tide: 0.5,
      tideZone: 'mid',      // from onTideZone — drives visual grammar
      barSec: 2.4,          // bar duration at current tempo (dock keeps fresh)
      fx: null,             // set below
      radial: null,         // set below
      cursor: null,         // set below
      pulseT: -9,           // one-shot all-seed pulse timestamp (garden full)
      uiScales: UI_SCALES,  // shared with Cursor for lattice math
      now() { return engine ? engine.now() : 0; },
      setDragging(b) {
        ui.dragging = b;
        if (b) { pluckGate.lastT = 0; pluckGate.lastMidi = -1; }
      },
      veilUp() { return veil && !veil.hidden; },

      setTide(v) {
        ui.tide = Math.min(1, Math.max(0, v));
        engine.setTide(ui.tide);
        if (ui.dock) ui.dock.showTide(ui.tide);
      },
      nudgeTide(d) { ui.setTide(ui.tide + d); },

      // y positions (px) of chord-tone pitch bands for the shimmer.
      // Inverse lattice map: y = 1 - latticeIdx/(span-1).
      chordBandYs(H) {
        const sc = UI_SCALES[ui.music.mode] || UI_SCALES.ionian;
        const span = sc.length * 3;
        const ys = [];
        const midis = engine.chordBandMidis(ui.barIdx);
        for (let i = 0; i < midis.length; i++) {
          const rel = midis[i] - 48 - ui.music.root;
          if (rel < 0) continue;
          const oct = Math.floor(rel / 12);
          const k = sc.indexOf(rel - oct * 12);
          if (k < 0) continue;
          const idx = oct * sc.length + k;
          if (idx >= span) continue;
          ys.push((1 - idx / (span - 1)) * H);
        }
        return ys;
      },

      // Pitch band (lattice index) at normalized y — preview-pluck gating.
      _midiAt(ny) {
        const sc = UI_SCALES[ui.music.mode] || UI_SCALES.ionian;
        const span = sc.length * 3;
        return Math.round((1 - ny) * (span - 1));
      },

      // Toast: brief aria-live message pill above the dock.
      toast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(ui._toastTimer);
        ui._toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
      },

      plantAt(x, y) {
        const id = engine.plant({
          x: x / window.innerWidth, y: y / window.innerHeight, voice: ui.brush
        });
        if (id === null) {
          // Garden full: three soft rings, a whispered toast, and every seed
          // pulses once so the user sees what to prune. Never auto-delete.
          const now = ui.now();
          ui.fx.ringAt(x, y, now, PALETTE.text, 0.4, false);
          ui.fx.ringAt(x, y, now + 0.15, PALETTE.text, 0.3, false);
          ui.fx.ringAt(x, y, now + 0.3, PALETTE.text, 0.2, false);
          ui.pulseT = performance.now() / 1000;
          ui.toast('garden is full');
          return;
        }
        ui.sprites.set(id, { x, y, voice: ui.brush, muted: false, k: 5, prob: 1 });
      },

      // Velocity-gated preview pluck: pointer slow (<200 px/s), >=90ms since
      // last pluck, and the pitch band actually changed.
      moveSeed(id, x, y, speed) {
        const s = ui.sprites.get(id);
        if (!s) return;
        s.x = x; s.y = y;
        const ny = y / window.innerHeight;
        engine.move(id, x / window.innerWidth, ny);
        const midi = ui._midiAt(ny);
        const now = performance.now();
        if ((speed || 0) < 200 && now - pluckGate.lastT >= 90 &&
            midi !== pluckGate.lastMidi) {
          pluckGate.lastT = now;
          pluckGate.lastMidi = midi;
          engine.previewPluck(id);   // stub until round 5 — safe no-op
        }
      },

      // Drag released without fling: one confirming pluck at final pitch.
      endDrag(id) {
        pluckGate.lastMidi = -1;
        engine.previewPluck(id);
      },

      toggleMute(id) {
        const s = ui.sprites.get(id);
        if (!s) return;
        s.muted = !s.muted;
        engine.mute(id, s.muted);
      },

      uprootSeed(id) {
        const s = ui.sprites.get(id);
        engine.remove(id);
        if (s && ui.fx) ui.fx.scatter(s.x, s.y, PALETTE[s.voice] || PALETTE.bloom);
        ui.sprites.delete(id);
      }
    };

    const renderer = createRenderer(canvas, ui);
    const fx = createFX(ui);
    ui.fx = fx;
    const engine = window.TideGarden.create({
      onStep(stepIdx, notes) {
        renderer.stepFlash(stepIdx);
        for (let i = 0; i < notes.length; i++) fx.ripple(notes[i]);
      },
      onBeat(barIdx) {
        ui.barIdx = barIdx; // keeps shimmer bands on the current chord
      },
      onTideZone(zone) {
        ui.tideZone = zone; // renderer + FX pick this up next frame
      },
      onMutate(seedId, change) {
        const s = ui.sprites.get(seedId);
        if (s) fx.sparkle(s.x, s.y, change.when);
      },
      onRestore(seeds, settings) {
        // Engine already applied everything — rebuild sprites + resync UI.
        ui.sprites.clear();
        const W = window.innerWidth, H = window.innerHeight;
        for (let i = 0; i < seeds.length; i++) {
          const sd = seeds[i];
          ui.sprites.set(sd.id, {
            x: sd.x * W, y: sd.y * H, voice: sd.voice,
            muted: sd.muted, k: sd.k, prob: sd.probability
          });
        }
        if (ui.dock) ui.dock.sync(settings);
      }
    });
    ui.radial = createRadial(ui, engine);
    ui.cursor = createCursor(ui, engine);
    createInput(canvas, ui);
    ui.dock = createDock(ui, engine);
    renderer.start();

    // expose for build-time debugging
    window._tg = { engine, ui };
  })();

})();
