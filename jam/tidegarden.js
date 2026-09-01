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
    function yToMidi(y, root, mode) {
      const sc = scale(mode);
      const span = sc.length * 3; // 3 octaves of lattice indices clipped to MIDI range
      const idx = Math.round((1 - y) * (span - 1));
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
    function euclid(k, n, rot) {
      const pat = new Array(n).fill(false);
      if (k <= 0) return pat;
      for (let i = 0; i < n; i++) {
        pat[(i + rot) % n] = Math.floor(i * k / n) !== Math.floor((i - 1) * k / n);
      }
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
    wet.gain.value = 0.8;
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
    master.gain.value = 0.9;

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

    return { input, reverbIn, tideFilter, comp, master, setTideFreq };
  }

  // ===== Voices =====
  // Round 3 delivers full Bloom/Drift/Pulse recipes. Round 1 ships the shared
  // note-routing helper plus a TEMP test tick so scheduler timing is audible.
  function createVoices(ctx, bus) {

    // route a voice output: dry into bus.input, send into bus.reverbIn
    function route(node, reverbSend) {
      const dry = ctx.createGain(); dry.gain.value = 1;
      const send = ctx.createGain(); send.gain.value = reverbSend;
      node.connect(dry); dry.connect(bus.input);
      node.connect(send); send.connect(bus.reverbIn);
      return { dry, send };
    }

    // TEMP: audible test tick to verify scheduler timing. Remove in round 3.
    function testTick(when, accent) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = accent ? 1200 : 800;
      g.gain.setValueAtTime(accent ? 0.25 : 0.12, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      osc.connect(g);
      route(g, 0.15);
      osc.start(when);
      osc.stop(when + 0.06);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    }

    return { route, testTick };
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

    function stepDur() { return 15 / tempo; } // 16th at bpm

    function tick() {
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
      getTempo() { return tempo; },
      getSwing() { return swing; }
    };
  }

  // ===== Garden =====
  // Round 3 delivers the full seed model. Round 1 ships id plumbing + storage
  // so plant/move stubs return real opaque ids Pixel can hold onto.
  function createGarden() {
    let nextId = 1;
    const seeds = new Map(); // id -> {x,y,voice,k,probability,muted}

    function makeId() { return 's' + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6); }

    return { seeds, makeId };
  }

  // ===== Store =====
  // Round 7 delivers the v1 hash codec + restore crossfade. Placeholder API shape.
  function createStore() {
    return {
      snapshot() { return 'v1|'; },   // stub
      restore(_str) { return false; } // stub
    };
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
        swing: 0
      };

      function ensureCtx() {
        if (ctx) return ctx;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        bus = createBus(ctx);
        voices = createVoices(ctx, bus);
        scheduler = createScheduler(ctx, {
          onStep: (i, notes) => { if (cb.onStep) cb.onStep(i, notes); },
          onBeat: (bar) => { if (cb.onBeat) cb.onBeat(bar); },
          resolveStep: (stepIdx, barIdx, when /*, dur */) => {
            // Round 1: empty notes[]. TEMP audible tick so timing is verifiable.
            voices.testTick(when, stepIdx === 0); // TEMP — remove in round 3
            return [];
          }
        });
        scheduler.setTempo(state.tempo);
        scheduler.setSwing(state.swing);
        bus.setTideFreq(state.tide, ctx.currentTime, 0);
        return ctx;
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

      const engine = {
        // --- transport / params (functional) ---
        start() { ensureCtx(); if (ctx.state === 'suspended') ctx.resume(); scheduler.start(); },
        stop() { if (scheduler) scheduler.stop(); },
        setTempo(bpm) { state.tempo = bpm; if (scheduler) scheduler.setTempo(bpm); },
        setSwing(s) { state.swing = s; if (scheduler) scheduler.setSwing(s); },
        setTide(v) {
          state.tide = Math.min(1, Math.max(0, v));
          if (bus) bus.setTideFreq(state.tide, ctx.currentTime, 0);
          // zone transitions (half-time / shimmer) land in round 5
        },
        setRoot(r) { state.root = ((r % 12) + 12) % 12; },
        setMode(m) { if (Theory.SCALES[m]) state.mode = m; },
        setMutation(v) { state.mutation = Math.min(1, Math.max(0, v)); },
        now() { return ctx ? ctx.currentTime : 0; },

        // --- garden (round-1 stubs: real opaque ids, no sound yet) ---
        plant(opts) {
          if (garden.seeds.size >= CONST.MAX_SEEDS) return null;
          const id = garden.makeId();
          garden.seeds.set(id, {
            x: opts.x, y: opts.y, voice: opts.voice || 'bloom',
            k: 5, probability: 1, muted: false
          });
          return id;
        },
        move(id, x, y) {
          const s = garden.seeds.get(id);
          if (s) { s.x = x; s.y = y; }
        },
        setDensity(id, k) { const s = garden.seeds.get(id); if (s) s.k = k; },
        setProbability(id, p) { const s = garden.seeds.get(id); if (s) s.probability = p; },
        mute(id, b) { const s = garden.seeds.get(id); if (s) s.muted = !!b; },
        remove(id) { garden.seeds.delete(id); },
        previewPluck(_id) { /* stub — round 5 */ },

        // --- state ---
        snapshot() { return store.snapshot(); },
        restore(str) { return store.restore(str); },

        // internals exposed read-only for debugging during build
        _debug: { CONST, PALETTE, Theory, state, garden }
      };

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
      if (S.mode !== 'idle') { reset(); return; } // 2nd pointer: safe reset
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
            // RADIAL stub — full radial menu is build round 8
            console.log('[radial stub] hold on seed', S.seedId);
          }
        }, CONST.HOLD_MS);
      }
    }

    function move(e) {
      if (e.pointerId !== S.pid || S.mode === 'idle') return;
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
      if (S.mode === 'drag' && S.seedId) ui.moveSeed(S.seedId, p.x, p.y);
      if (S.mode === 'radial') {
        // round 8: distance = density, angle = probability
      }
    }

    function up(e) {
      if (e.pointerId !== S.pid || S.mode === 'idle') return;
      const now = performance.now();
      const speed = Math.hypot(S.vx, S.vy);

      if (S.mode === 'drag' && S.seedId && speed > CONST.FLING) {
        ui.uprootSeed(S.seedId);                       // fling = uproot
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

    function drawBackground() {
      const g = c2d.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, PALETTE.bgHigh);
      g.addColorStop(1, PALETTE.bg);
      c2d.fillStyle = g;
      c2d.fillRect(0, 0, W, H);
    }

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

    function drawSeeds(tSec) {
      ui.sprites.forEach((s) => {
        const col = PALETTE[s.voice] || PALETTE.bloom;
        c2d.globalAlpha = s.muted ? 0.3 : 1;
        // soft halo
        c2d.fillStyle = col;
        c2d.beginPath();
        c2d.arc(s.x, s.y, 14, 0, Math.PI * 2);
        c2d.globalAlpha *= 0.18;
        c2d.fill();
        // core dot with a gentle step pulse
        const pulse = (tSec - lastStepFlash.t) < 0.15 ? 1.5 : 0;
        c2d.globalAlpha = s.muted ? 0.35 : 1;
        c2d.beginPath();
        c2d.arc(s.x, s.y, 6 + pulse, 0, Math.PI * 2);
        c2d.fill();
      });
      c2d.globalAlpha = 1;
    }

    function frame() {
      if (!running) return;
      if (!document.hidden && !ui.veilUp()) {
        const tSec = performance.now() / 1000;
        drawBackground();          // 1. tide gradient
        drawRings(tSec);           // 2. breathing rings
        // 3. chord-band shimmer (round 4, drag only)
        drawSeeds(tSec);           // 4. seeds
        // 5. ripples/sparkles from FX ring buffer (round 4)
        // 6. keyboard cursor (round 8)
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
  // (Pixel — build round 4: pooled ripples at `when`, chord-band shimmer)

  // ===== Radial =====
  // (Pixel — build round 8)

  // ===== Dock =====
  // (Pixel — build round 6)

  // ===== Cursor =====
  // (Pixel — build round 8)

  // ===== boot =====
  (function boot() {
    const canvas = document.getElementById('water');
    const veil = document.getElementById('start-veil');
    if (!canvas) return;

    // UI-side sprite registry + shared helpers for Input/Renderer.
    const ui = {
      sprites: new Map(),   // engineId -> {x, y, voice, muted}
      brush: 'bloom',       // cycled by dock (round 6)
      dragging: false,
      setDragging(b) { ui.dragging = b; },
      veilUp() { return veil && !veil.hidden; },
      plantAt(x, y) {
        const ny = y / window.innerHeight; // normalized for engine
        const id = engine.plant({ x: x / window.innerWidth, y: ny, voice: ui.brush });
        if (id === null) {
          // garden full — polite ripple + pulse lands in round 8 (needs toast)
          console.log('[garden full]');
          return;
        }
        ui.sprites.set(id, { x, y, voice: ui.brush, muted: false });
      },
      moveSeed(id, x, y) {
        const s = ui.sprites.get(id);
        if (!s) return;
        s.x = x; s.y = y;
        engine.move(id, x / window.innerWidth, y / window.innerHeight);
      },
      toggleMute(id) {
        const s = ui.sprites.get(id);
        if (!s) return;
        s.muted = !s.muted;
        engine.mute(id, s.muted);
      },
      uprootSeed(id) {
        engine.remove(id);
        ui.sprites.delete(id); // petal-scatter FX lands in round 4
      }
    };

    const renderer = createRenderer(canvas, ui);
    const engine = window.TideGarden.create({
      onStep(stepIdx, notes) {
        renderer.stepFlash(stepIdx);
        // round 4: push notes (with `when`) into FX ring buffer
        void notes;
      },
      onBeat(_barIdx) { /* round 6: tide-zone visual grammar hooks */ }
    });
    createInput(canvas, ui);
    renderer.start();

    // expose for build-time debugging
    window._tg = { engine, ui };
  })();

})();
