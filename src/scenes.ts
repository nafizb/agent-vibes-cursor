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

// --- shared --------------------------------------------------------------

function wrap(s: MusicalState, layers: string[]): string {
  const body = layers.length ? layers.join(",\n  ") : `s("silence")`;
  // Master tension widens a subtle global low-pass wobble.
  const masterLpf = s.tension > 0.2 ? `.lpf(${f(20000 - s.tension * 14000)})` : "";
  // `.analyze(1)` taps the master output so the VU meter can read real levels.
  return `setcps(${f(s.cps, 3)})\nstack(\n  ${body}\n)${masterLpf}.analyze(1)`;
}
