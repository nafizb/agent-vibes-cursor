import { buildPattern, SCENES } from "../src/scenes";
import { MusicalState, SceneId } from "../src/types";

// Provided globally by @strudel/web's index.js (loaded as a classic script).
declare function initStrudel(opts?: any): Promise<void> | void;
declare function evaluate(code: string): Promise<unknown> | unknown;
declare function hush(): void;
declare function getAudioContext(): AudioContext;
declare function getAnalyzerData(type?: "time" | "frequency", id?: number): Float32Array | undefined;

declare global {
  interface Window {
    __VIBE__: { scene: SceneId };
    acquireVsCodeApi: () => { postMessage: (m: any) => void };
  }
}

const vscode = window.acquireVsCodeApi();

let enabled = false;
let initialized = false;
let paused = false;
let currentScene: SceneId = window.__VIBE__.scene;
let lastState: MusicalState | undefined;
let lastCode = "";
let lastEvalAt = 0;
const MIN_EVAL_INTERVAL = 700; // ms -- avoid clicky re-evaluation

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function renderScenes() {
  const host = $("scenes");
  host.innerHTML = "";
  for (const s of SCENES) {
    const btn = document.createElement("button");
    btn.className = "scene" + (s.id === currentScene ? " active" : "");
    btn.dataset.scene = s.id;
    btn.innerHTML = `<b>${s.label}</b><span>${s.blurb}</span>`;
    btn.addEventListener("click", () => selectScene(s.id));
    host.appendChild(btn);
  }
}

function selectScene(scene: SceneId) {
  currentScene = scene;
  renderScenes();
  vscode.postMessage({ type: "scene", scene });
}

async function enableAudio() {
  if (initialized) return;
  try {
    await initStrudel({});
    initialized = true;
    enabled = true;
    ($("enable") as HTMLButtonElement).textContent = "♪ Playing";
    ($("enable") as HTMLButtonElement).disabled = true;
    ($("pause") as HTMLButtonElement).style.display = "block";
    if (lastState) applyState(lastState, true);
  } catch (err) {
    ($("enable") as HTMLButtonElement).textContent = "Audio failed — retry";
    console.error("[agent-vibes-cursor] initStrudel failed", err);
  }
}

function applyState(state: MusicalState, force = false) {
  lastState = state;
  updateMeters(state);
  if (!enabled || !initialized || paused) return;

  const code = buildPattern({ ...state, scene: currentScene });
  const now = Date.now();
  if (!force && code === lastCode) return;
  if (!force && now - lastEvalAt < MIN_EVAL_INTERVAL) return;

  lastCode = code;
  lastEvalAt = now;
  try {
    Promise.resolve(evaluate(code)).catch((e) => console.error("[agent-vibes-cursor] evaluate", e));
  } catch (e) {
    console.error("[agent-vibes-cursor] evaluate threw", e);
  }
}

function updateMeters(s: MusicalState) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  ($("iBar") as HTMLElement).style.width = pct(s.intensity);
  ($("tBar") as HTMLElement).style.width = pct(s.tension);
  // Map cps (~0.4..1.0) onto the bar.
  ($("cBar") as HTMLElement).style.width = pct((s.cps - 0.4) / 0.6);
  $("iVal").textContent = s.intensity.toFixed(2);
  $("tVal").textContent = s.tension.toFixed(2);
  $("cVal").textContent = s.cps.toFixed(2);
  $("phase").textContent = `phase: ${s.phase}  ·  voices: ${s.voices}  ·  ${currentScene}`;
}

// --- Live signal monitor -------------------------------------------------

interface RawEvent {
  ts: number;
  kind: string;
  tool?: string;
  source: "transcript" | "hooks" | "editor" | "composer";
  category?: string;
}

const WINDOW_MS = 12000;
const events: RawEvent[] = [];
const counts = { transcript: 0, hooks: 0, editor: 0, composer: 0 };

const KIND_WEIGHT: Record<string, number> = {
  "tool-fail": 1,
  response: 1,
  prompt: 0.88,
  stop: 0.72,
  "subagent-start": 0.7,
  "subagent-stop": 0.7,
  tool: 0.6,
  "session-start": 0.5,
  thought: 0.42,
  draft: 0.34,
  typing: 0.24,
};

/** Composer typing gets a stronger rhythm bar than file typing. */
function eventWeight(ev: RawEvent): number {
  if (ev.source === "composer" && ev.kind === "typing") return 0.38;
  return KIND_WEIGHT[ev.kind] ?? 0.4;
}

const SOURCE_COLOR: Record<string, string> = {
  transcript: "#4a90d9",
  hooks: "#e0564a",
  editor: "#4ac06b",
  composer: "#b48ce0",
};

const SOURCE_PILL: Record<string, string> = {
  transcript: "transcript",
  hooks: "hooks",
  editor: "files",
  composer: "prompt",
};

function recordEvent(ev: RawEvent) {
  ev.ts = ev.ts || Date.now();
  events.push(ev);
  if (events.length > 400) events.shift();
  // Composer "typing" is a music-only pulse that shadows the "draft" event at the
  // same instant. Let it drive the rhythm canvas, but don't double the pill/feed.
  if (ev.source === "composer" && ev.kind === "typing") return;
  if (ev.source in counts) {
    counts[ev.source]++;
    const pill = document.getElementById(`src-${ev.source}`);
    if (pill) {
      const name = SOURCE_PILL[ev.source] ?? ev.source;
      pill.textContent = `${name} ${counts[ev.source]}`;
      pill.classList.add("hot");
      setTimeout(() => pill.classList.remove("hot"), 220);
    }
  }
  addFeedRow(ev);
}

function addFeedRow(ev: RawEvent) {
  const feed = $("feed");
  const row = document.createElement("div");
  row.className = `ev ${ev.source}`;
  const time = new Date(ev.ts).toLocaleTimeString("en-GB");
  const label = feedLabel(ev);
  row.innerHTML = `<span class="t">${time}</span><span class="k">${label}</span><span class="s">${ev.source}</span>`;
  feed.prepend(row);
  while (feed.childElementCount > 60) feed.lastElementChild?.remove();
}

function feedLabel(ev: RawEvent): string {
  if (ev.source === "composer") {
    if (ev.kind === "draft" || ev.kind === "typing") return "prompting";
  }
  if (ev.tool) return `${ev.kind}:${ev.tool}`;
  return ev.kind;
}

function setupRhythm() {
  const canvas = $("rhythm") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.floor(64 * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  function draw() {
    const w = canvas.clientWidth;
    const h = 64;
    ctx!.clearRect(0, 0, w, h);

    // "now" edge marker on the right.
    ctx!.strokeStyle = "rgba(255,255,255,0.12)";
    ctx!.lineWidth = 1;
    ctx!.beginPath();
    ctx!.moveTo(w - 0.5, 0);
    ctx!.lineTo(w - 0.5, h);
    ctx!.stroke();

    const now = Date.now();
    while (events.length && now - events[0].ts > WINDOW_MS) events.shift();

    for (const ev of events) {
      const age = now - ev.ts;
      const x = w * (1 - age / WINDOW_MS);
      if (x < 0) continue;
      const weight = eventWeight(ev);
      const barH = 6 + weight * (h - 10);
      const alpha = 0.35 + 0.65 * (1 - age / WINDOW_MS);
      ctx!.strokeStyle = hexA(ev.kind === "tool-fail" ? "#e0564a" : SOURCE_COLOR[ev.source], alpha);
      ctx!.lineWidth = ev.kind === "tool-fail" || ev.kind === "response" ? 2.5 : 1.5;
      ctx!.beginPath();
      ctx!.moveTo(x, h);
      ctx!.lineTo(x, h - barH);
      ctx!.stroke();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// --- VU meter (reads the real master output via Strudel's analyser) ------

let vuLevel = 0;
let vuPeak = 0;

function readLevel(): number {
  if (!enabled || paused || typeof getAnalyzerData !== "function") return 0;
  let data: Float32Array | undefined;
  try {
    data = getAnalyzerData("time", 1);
  } catch {
    return 0;
  }
  if (!data || !data.length) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length); // RMS, ~0..1
}

function setupVu() {
  const canvas = $("vu") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.floor(22 * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  const SEGMENTS = 28;
  const GAP = 2;

  function frame() {
    const w = canvas.clientWidth;
    const h = 22;
    // Map RMS (often small) onto a lively 0..1 with a soft knee.
    const target = Math.min(1, readLevel() * 3.4);
    // Fast attack, slow release -- classic VU ballistics.
    vuLevel += (target - vuLevel) * (target > vuLevel ? 0.5 : 0.12);
    vuPeak = Math.max(vuPeak * 0.95, vuLevel);

    ctx!.clearRect(0, 0, w, h);
    const segW = (w - (SEGMENTS - 1) * GAP) / SEGMENTS;
    const peakIdx = Math.round(vuPeak * (SEGMENTS - 1));
    for (let i = 0; i < SEGMENTS; i++) {
      const frac = i / (SEGMENTS - 1);
      const on = vuLevel >= frac - 0.0001;
      const color = frac < 0.6 ? "#4ac06b" : frac < 0.85 ? "#e0c84a" : "#e0564a";
      ctx!.fillStyle = i === peakIdx ? "rgba(255,255,255,0.85)" : on ? color : "rgba(255,255,255,0.07)";
      ctx!.fillRect(i * (segW + GAP), 0, segW, h);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function updateDiag(data: Record<string, string>) {
  for (const key of ["transcript", "hooks", "composer"]) {
    const el = document.getElementById(`diag-${key}`);
    if (el && data[key]) el.textContent = data[key];
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "state") {
    applyState(msg.state as MusicalState);
  } else if (msg?.type === "event") {
    recordEvent(msg.event as RawEvent);
  } else if (msg?.type === "diag") {
    updateDiag(msg.data as Record<string, string>);
  } else if (msg?.type === "stop") {
    enabled = false;
    try {
      hush();
    } catch {
      /* ignore */
    }
    ($("enable") as HTMLButtonElement).textContent = "▶ Enable audio";
    ($("enable") as HTMLButtonElement).disabled = false;
    initialized = initialized; // keep engine warm; just silenced
    enabled = false;
  }
});

function audioCtx(): AudioContext | undefined {
  try {
    return typeof getAudioContext === "function" ? getAudioContext() : undefined;
  } catch {
    return undefined;
  }
}

function togglePause() {
  if (!initialized) return;
  paused = !paused;
  const btn = $("pause") as HTMLButtonElement;
  const ctx = audioCtx();
  if (paused) {
    // Suspending the AudioContext halts ALL sound instantly (and pauses the
    // scheduler clock), which is more reliable than hush() in this build.
    ctx?.suspend?.().catch(() => {});
    try {
      hush();
    } catch {
      /* ignore */
    }
    lastCode = ""; // force re-eval on resume
    btn.textContent = "▶ Resume";
  } else {
    ctx?.resume?.().catch(() => {});
    btn.textContent = "⏸ Pause";
    if (lastState) applyState(lastState, true);
  }
}

$("enable").addEventListener("click", enableAudio);
$("pause").addEventListener("click", togglePause);
renderScenes();
setupRhythm();
setupVu();
