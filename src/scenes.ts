import { MusicalState, SceneId } from "./types";

export interface SceneMeta {
  id: SceneId;
  label: string;
  blurb: string;
}

export const SCENES: SceneMeta[] = [
  { id: "cinematic", label: "Cinematic", blurb: "Hans Zimmer-style build to a drop" },
  { id: "techno", label: "Techno", blurb: "Driving 4-on-the-floor build" },
  { id: "lofi", label: "Lo-fi", blurb: "Warm, relaxed beats" },
  { id: "chiptune", label: "Chiptune", blurb: "8-bit arpeggio energy" },
  { id: "piano", label: "Piano", blurb: "Einaudi-style neoclassical piano" },
  { id: "jazz", label: "Jazz", blurb: "Smoky late-night swing" },
];

const f = (n: number, d = 3) => Number(n.toFixed(d)).toString();
const upper = (k: string) => k.toUpperCase();

/** Active above a threshold, ramped 0..1 across a window for smooth entries. */
function ramp(value: number, from: number, to: number): number {
  if (value <= from) return 0;
  if (value >= to) return 1;
  return (value - from) / (to - from);
}

/**
 * Turn the current musical state into a complete Strudel program string.
 * Layers fade in by intensity, tension adds dissonance + closes the filter,
 * and `cps` sets the tempo. The webview re-evaluates this only when it changes.
 */
export function buildPattern(state: MusicalState): string {
  switch (state.scene) {
    case "cinematic":
      return cinematic(state);
    case "techno":
      return techno(state);
    case "lofi":
      return lofi(state);
    case "chiptune":
      return chiptune(state);
    case "piano":
      return piano(state);
    case "jazz":
      return jazz(state);
    default:
      return cinematic(state);
  }
}

// --- Cinematic: the showcase scene --------------------------------------

function cinematic(s: MusicalState): string {
  const i = s.intensity;
  const t = s.tension;
  const scale = `${upper(s.key)}3:${s.mode}`;
  const bassScale = `${upper(s.key)}1:${s.mode}`;
  const layers: string[] = [];

  // Drone pad -- always present; brightness + width tracks intensity.
  const padLpf = 280 + i * 3600 - t * 1200;
  layers.push(
    `n("0,2,4").scale("${scale}").s("sawtooth")` +
      `.lpf(sine.range(${f(Math.max(180, padLpf - 400))},${f(Math.max(220, padLpf))}).slow(9))` +
      `.attack(1.4).release(3).gain(${f(0.22 + 0.16 * i)}).room(0.85).slow(4)`
  );

  // Dissonant b9 swell -- the tension cue.
  if (t > 0.05) {
    layers.push(
      `n("1").scale("${scale}").s("sawtooth").add(note(12))` +
        `.lpf(900).gain(${f(0.18 * t)}).room(0.7).slow(4)`
    );
  }

  // Sub bass -- enters once we are moving.
  const bassGain = ramp(i, 0.18, 0.5);
  if (bassGain > 0) {
    layers.push(
      `n("0 ~ <0 4> ~").scale("${bassScale}").s("sawtooth")` +
        `.lpf(${f(220 + i * 300)}).attack(0.01).release(0.4).gain(${f(0.32 * bassGain)})`
    );
  }

  // Heartbeat kick -- synthesised, no samples needed.
  const kickGain = ramp(i, 0.25, 0.6);
  if (kickGain > 0) {
    layers.push(
      `note("c1").s("sine").struct("x ~ ~ ~ x ~ ~ ~")` +
        `.attack(0.001).decay(0.16).sustain(0).gain(${f(0.7 * kickGain)})`
    );
  }

  // Ticking hats -- research/working texture.
  const hatGain = ramp(i, 0.4, 0.75);
  if (hatGain > 0) {
    layers.push(
      `s("white").struct("~ x ~ x ~ x ~ x")` +
        `.decay(0.03).sustain(0).hpf(8500).gain(${f(0.18 * hatGain)})`
    );
  }

  // The drop -- arp lead at climax.
  if (s.phase === "drop" || i > 0.8) {
    const lead = ramp(i, 0.78, 0.95);
    layers.push(
      `n("0 2 4 7 4 2").scale("${scale}").s("triangle").fast(2)` +
        `.lpf(${f(2000 + i * 4000)}).gain(${f(0.22 * lead)}).delay(0.35).delaytime(0.18).room(0.4)`
    );
  }

  return wrap(s, layers);
}

// --- Techno --------------------------------------------------------------

function techno(s: MusicalState): string {
  const i = s.intensity;
  const t = s.tension;
  const scale = `${upper(s.key)}1:${s.mode}`;
  const layers: string[] = [];

  // Four-on-the-floor kick, always running in this scene.
  layers.push(
    `note("c1").s("sine").struct("x x x x")` +
      `.attack(0.001).decay(0.18).sustain(0).gain(${f(0.6 + 0.2 * i)})`
  );

  const bassGain = ramp(i, 0.2, 0.55);
  if (bassGain > 0) {
    layers.push(
      `n("0 0 <3 5> 0").scale("${scale}").s("sawtooth")` +
        `.lpf(sine.range(300,${f(600 + i * 2500)}).slow(4)).gain(${f(0.3 * bassGain)})`
    );
  }

  const hatGain = ramp(i, 0.3, 0.6);
  if (hatGain > 0) {
    layers.push(
      `s("white").struct("~ x ~ x ~ x ~ x".fast(2))` +
        `.decay(0.025).sustain(0).hpf(9000).gain(${f(0.16 * hatGain)})`
    );
  }

  const clapGain = ramp(i, 0.45, 0.7);
  if (clapGain > 0) {
    layers.push(
      `s("white").struct("~ ~ ~ ~ x ~ ~ ~")` +
        `.decay(0.12).sustain(0).bpf(2000).gain(${f(0.3 * clapGain)})`
    );
  }

  if (t > 0.1) {
    layers.push(`s("white").decay(0.6).sustain(0).hpf(${f(2000 + t * 6000)}).gain(${f(0.1 * t)}).slow(8)`);
  }

  return wrap(s, layers);
}

// --- Lo-fi ---------------------------------------------------------------

function lofi(s: MusicalState): string {
  const i = s.intensity;
  const scale = `${upper(s.key)}3:${s.mode}`;
  const bassScale = `${upper(s.key)}2:${s.mode}`;
  const layers: string[] = [];

  // Warm electric-piano-ish chords.
  layers.push(
    `n("<[0,2,4] [1,3,5]>").scale("${scale}").s("triangle")` +
      `.lpf(1600).attack(0.05).release(0.8).gain(${f(0.2 + 0.1 * i)}).room(0.5).slow(2)`
  );

  layers.push(
    `n("0 ~ 4 ~").scale("${bassScale}").s("sine").gain(${f(0.25 + 0.1 * i)}).release(0.3)`
  );

  const kickGain = ramp(i, 0.2, 0.5);
  if (kickGain > 0) {
    layers.push(
      `note("c1").s("sine").struct("x ~ ~ x ~ ~ x ~")` +
        `.decay(0.18).sustain(0).gain(${f(0.55 * kickGain)})`
    );
    layers.push(
      `s("white").struct("~ ~ x ~ ~ ~ x ~").decay(0.1).sustain(0).bpf(1800).gain(${f(0.18 * kickGain)})`
    );
  }

  const hatGain = ramp(i, 0.35, 0.65);
  if (hatGain > 0) {
    layers.push(`s("white").struct("x x x x".fast(2)).decay(0.02).sustain(0).hpf(8000).gain(${f(0.1 * hatGain)})`);
  }

  return wrap(s, layers);
}

// --- Chiptune ------------------------------------------------------------

function chiptune(s: MusicalState): string {
  const i = s.intensity;
  const scale = `${upper(s.key)}4:${s.mode}`;
  const bassScale = `${upper(s.key)}2:${s.mode}`;
  const layers: string[] = [];

  // Square-wave arpeggio, gets faster/busier with intensity.
  const arpSpeed = 2 + Math.round(i * 2);
  layers.push(
    `n("0 2 4 7").scale("${scale}").s("square").fast(${arpSpeed})` +
      `.gain(${f(0.16 + 0.08 * i)}).release(0.08)`
  );

  layers.push(
    `n("0 0 <4 5> 0").scale("${bassScale}").s("square").gain(${f(0.22 + 0.08 * i)}).release(0.1)`
  );

  const kickGain = ramp(i, 0.2, 0.5);
  if (kickGain > 0) {
    layers.push(
      `note("c1").s("triangle").struct("x ~ x ~").decay(0.1).sustain(0).gain(${f(0.5 * kickGain)})`
    );
  }

  const noiseGain = ramp(i, 0.4, 0.7);
  if (noiseGain > 0) {
    layers.push(`s("white").struct("~ x ~ x").decay(0.03).sustain(0).hpf(7000).gain(${f(0.14 * noiseGain)})`);
  }

  return wrap(s, layers);
}

// --- Piano ---------------------------------------------------------------

// Neoclassical piano -- Ludovico Einaudi by way of an agent run. A patient
// left-hand bass and a circling right-hand arpeggio orbit the same few chords;
// strings swell underneath and a high melodic phrase resolves at the drop.
// Everything is oscillator-synthesized (no samples) to stay offline, so the
// "piano" is a soft triangle voice with a fast strike and a long, pedalled tail.
function piano(s: MusicalState): string {
  const i = s.intensity;
  const t = s.tension;
  const scale = `${upper(s.key)}4:${s.mode}`; // right hand
  const midScale = `${upper(s.key)}3:${s.mode}`; // inner voices / strings
  const bassScale = `${upper(s.key)}2:${s.mode}`; // left hand
  const lowScale = `${upper(s.key)}1:${s.mode}`; // pedal octave bloom
  const layers: string[] = [];

  // Left hand: a slow, sustained broken chord -- root, then a wandering colour
  // tone. This is the anchor that's always present, even when idle.
  layers.push(
    `n("<0 ~ <5 3> ~>").scale("${bassScale}").s("triangle")` +
      `.attack(0.006).decay(0.9).sustain(0.3).release(1.4)` +
      `.lpf(${f(800 + i * 700)}).gain(${f(0.26 + 0.07 * i)}).room(0.7).slow(2)`
  );

  // Right hand: the signature flowing arpeggio. It fills out and quickens a
  // little as the agent works, but never loses its contemplative gait.
  const arpSpeed = 2 + Math.round(i * 2); // 2..4
  layers.push(
    `n("0 2 4 7 4 2").scale("${scale}").s("triangle").fast(${arpSpeed})` +
      `.attack(0.004).decay(0.5).sustain(0).release(0.5)` +
      `.lpf(${f(2200 + i * 3200)}).gain(${f(0.15 + 0.07 * i)})` +
      `.room(0.8).delay(0.18).delaytime(0.33).delayfeedback(0.25)`
  );

  // Octave-up shimmer doubling the arpeggio -- enters mid-run for sparkle.
  const shimmer = ramp(i, 0.35, 0.72);
  if (shimmer > 0) {
    layers.push(
      `n("0 2 4 7 4 2").scale("${scale}").s("sine").add(note(12)).fast(${arpSpeed})` +
        `.attack(0.004).decay(0.4).sustain(0).hpf(1200)` +
        `.gain(${f(0.07 * shimmer)}).room(0.85)`
    );
  }

  // String pad swell beneath the piano -- the neoclassical "lift".
  const padGain = ramp(i, 0.2, 0.62);
  if (padGain > 0) {
    layers.push(
      `n("0,2,4").scale("${midScale}").s("sawtooth")` +
        `.lpf(sine.range(500,${f(1200 + i * 1400)}).slow(8))` +
        `.attack(1.6).release(3).gain(${f(0.12 * padGain)}).room(0.9).slow(4)`
    );
  }

  // Tension: a suspended, unresolved upper voice when the agent stalls or fails.
  if (t > 0.08) {
    layers.push(
      `n("1").scale("${midScale}").s("triangle").add(note(7))` +
        `.attack(0.6).release(2.4).lpf(1400).gain(${f(0.12 * t)}).room(0.7).slow(4)`
    );
  }

  // The drop / resolve: a descending melodic phrase over a low octave bloom.
  if (s.phase === "drop" || i > 0.82) {
    const peak = ramp(i, 0.8, 0.97);
    layers.push(
      `n("7 4 2 4 0 ~").scale("${scale}").s("triangle")` +
        `.attack(0.004).decay(0.7).sustain(0).gain(${f(0.18 * peak)})` +
        `.lpf(4200).room(0.85).delay(0.25).delaytime(0.4).delayfeedback(0.3)`
    );
    layers.push(
      `n("0").scale("${lowScale}").s("triangle")` +
        `.attack(0.01).decay(1.6).sustain(0).gain(${f(0.3 * peak)}).room(0.75).slow(2)`
    );
  }

  return wrap(s, layers);
}

// --- Jazz ----------------------------------------------------------------

// Smoky, late-night jazz -- a small combo translated through an agent run. A
// walking upright bass and a swung ride cymbal lope underneath syncopated
// Rhodes-style comping built on jazzy extended (7th / 9th) chords, the harmony
// leaning on dorian and mixolydian colour. Brushes and the drummer's hi-hat
// foot fall in on 2 & 4 as the take heats up, and a bluesy sax-like lead steps
// out for a solo at the drop. Everything is oscillator-synthesized to stay
// offline: the "Rhodes" is a soft sine with a bell-ish attack, the upright a
// round triangle, the cymbals and brushes filtered noise.
function jazz(s: MusicalState): string {
  const i = s.intensity;
  const t = s.tension;
  const scale = `${upper(s.key)}3:${s.mode}`; // comping / inner voices
  const leadScale = `${upper(s.key)}4:${s.mode}`; // sax-like lead
  const bassScale = `${upper(s.key)}2:${s.mode}`; // walking upright bass
  const layers: string[] = [];

  // Walking bass -- the spine. Four steps to the bar, alternating ascending and
  // descending lines so it wanders between the changes like an upright player.
  layers.push(
    `n("<[0 2 3 4] [5 4 2 0] [0 1 2 4] [4 3 2 1]>").scale("${bassScale}").s("triangle")` +
      `.attack(0.012).decay(0.34).sustain(0.16).release(0.18)` +
      `.lpf(${f(520 + i * 520)}).gain(${f(0.32 + 0.06 * i)}).room(0.28)`
  );

  // Swung ride cymbal -- the "spang, spang-a-lang". Each off-beat is a long-short
  // pair ([x@2 x]) so the whole pattern lopes with a triplet swing feel.
  layers.push(
    `s("white").struct("x [x@2 x] x [x@2 x]")` +
      `.decay(0.07).sustain(0).hpf(7200).gain(${f(0.09 + 0.05 * i)}).room(0.35)`
  );

  // Rhodes-style comping -- syncopated extended-chord stabs on the off-beats,
  // the Charleston push-and-pull that makes a combo swing. Always present, soft.
  const compGain = ramp(i, 0.1, 0.5);
  layers.push(
    `n("~ <[0,2,4,6] [1,3,5,7]> ~ ~ <[0,2,4,6] [-1,1,3,5]> ~ ~ ~").scale("${scale}").s("sine")` +
      `.attack(0.006).decay(0.55).sustain(0).release(0.35)` +
      `.lpf(${f(1600 + i * 1800)}).gain(${f(0.11 + 0.1 * compGain)})` +
      `.room(0.5).delay(0.12).delaytime(0.36).delayfeedback(0.18)`
  );

  // Brushed backbeat on 2 & 4 -- the swish of brushes on the snare, entering as
  // the take warms up.
  const brushGain = ramp(i, 0.2, 0.55);
  if (brushGain > 0) {
    layers.push(
      `s("white").struct("~ x ~ x").decay(0.13).sustain(0)` +
        `.bpf(2400).gain(${f(0.16 * brushGain)}).room(0.4)`
    );
  }

  // Feathered kick -- the quiet four-on-the-floor a jazz drummer ghosts under
  // the time, only once there's real momentum.
  const kickGain = ramp(i, 0.4, 0.72);
  if (kickGain > 0) {
    layers.push(
      `note("c1").s("sine").struct("x ~ x ~ x ~ x ~")` +
        `.attack(0.002).decay(0.14).sustain(0).gain(${f(0.28 * kickGain)})`
    );
  }

  // Tension: a held, unresolved altered voicing (tritone colour) when the agent
  // stalls or a tool fails -- the anxious "what chord comes next" suspension.
  if (t > 0.08) {
    layers.push(
      `n("<[0,3,6] [1,4,6]>").scale("${scale}").s("sawtooth")` +
        `.attack(0.5).release(2).lpf(${f(900 + t * 600)})` +
        `.gain(${f(0.1 * t)}).room(0.7).slow(2)`
    );
  }

  // The drop / solo: a bluesy sax-like lead steps out over a doubled root --
  // the head-out chorus when the agent lands the answer.
  if (s.phase === "drop" || i > 0.8) {
    const solo = ramp(i, 0.78, 0.96);
    layers.push(
      `n("4 ~ <6 5> 7 6 4 <2 1> ~").scale("${leadScale}").s("triangle")` +
        `.attack(0.02).decay(0.4).sustain(0.2).release(0.3)` +
        `.lpf(${f(2600 + i * 2600)}).gain(${f(0.2 * solo)})` +
        `.room(0.45).delay(0.2).delaytime(0.3).delayfeedback(0.25)`
    );
    layers.push(
      `n("0").scale("${bassScale}").s("sine").struct("x ~ ~ ~")` +
        `.attack(0.01).decay(0.5).sustain(0.2).gain(${f(0.26 * solo)}).room(0.3)`
    );
  }

  return wrap(s, layers);
}

// --- shared --------------------------------------------------------------

function wrap(s: MusicalState, layers: string[]): string {
  const body = layers.length ? layers.join(",\n  ") : `s("silence")`;
  // Master tension widens a subtle global low-pass wobble.
  const masterLpf = s.tension > 0.2 ? `.lpf(${f(20000 - s.tension * 14000)})` : "";
  // `.analyze(1)` taps the master output so the VU meter can read real levels.
  return `setcps(${f(s.cps, 3)})\nstack(\n  ${body}\n)${masterLpf}.analyze(1)`;
}
