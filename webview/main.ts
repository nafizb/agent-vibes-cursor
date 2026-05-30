import { buildPattern, SCENES } from "../src/scenes";
import { MusicalState, SceneId } from "../src/types";

// Provided globally by @strudel/web's index.js (loaded as a classic script).
declare function initStrudel(opts?: any): Promise<void> | void;
declare function evaluate(code: string): Promise<unknown> | unknown;
declare function hush(): void;
declare function getAudioContext(): AudioContext;
declare function getAnalyzerData(
  type?: "time" | "frequency",
  id?: number,
): Float32Array | undefined;

declare global {
  interface Window {
    __VIBE__: { scene: SceneId };
    acquireVsCodeApi: () => { postMessage: (m: any) => void };
  }
}

const vscode = window.acquireVsCodeApi();
const root = document.getElementById("vibe") as HTMLElement;
const prefersReduced = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

let audioEnabled = false;
let audioReady = false;
let paused = false;
let currentScene: SceneId = window.__VIBE__.scene;
let state: MusicalState | undefined;
let lastCode = "";
let lastEvalAt = 0;
const MIN_EVAL_INTERVAL = 700; // ms -- avoid clicky re-evaluation

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
function maybe(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// --- meters + phase ------------------------------------------------------

const iBar = $("i-bar");
const tBar = $("t-bar");
const cBar = $("c-bar");
const iVal = $("i-val");
const tVal = $("t-val");
const cVal = $("c-val");
const voicesEl = $("voices");
const phaseEls = Array.from(
  root.querySelectorAll<HTMLElement>(".phase[data-phase]"),
);

function applyState(s: MusicalState, force = false) {
  state = s;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  iBar.style.width = pct(s.intensity);
  tBar.style.width = pct(s.tension);
  cBar.style.width = pct((s.cps - 0.4) / 0.6);
  iVal.textContent = s.intensity.toFixed(2);
  tVal.textContent = s.tension.toFixed(2);
  cVal.textContent = s.cps.toFixed(2);
  voicesEl.textContent = String(s.voices);

  for (const el of phaseEls) {
    el.classList.toggle("is-active", el.dataset.phase === s.phase);
  }
  root.dataset.phase = s.phase;
  root.style.setProperty("--energy", s.intensity.toFixed(3));
  root.style.setProperty("--tension", s.tension.toFixed(3));

  if (!audioEnabled || !audioReady || paused) return;
  const code = buildPattern({ ...s, scene: currentScene });
  const now = Date.now();
  if (!force && (code === lastCode || now - lastEvalAt < MIN_EVAL_INTERVAL)) {
    return;
  }
  lastCode = code;
  lastEvalAt = now;
  try {
    Promise.resolve(evaluate(code)).catch((e) =>
      console.error("[agent-vibes-cursor] evaluate", e),
    );
  } catch (e) {
    console.error("[agent-vibes-cursor] evaluate threw", e);
  }
}

// --- scene chips ---------------------------------------------------------

function renderScenes() {
  const host = $("scenes");
  host.innerHTML = "";
  for (const s of SCENES) {
    const btn = document.createElement("button");
    btn.className = "schip" + (s.id === currentScene ? " is-active" : "");
    btn.dataset.scene = s.id;
    btn.type = "button";
    btn.title = s.blurb;
    btn.textContent = s.label;
    btn.setAttribute("aria-pressed", String(s.id === currentScene));
    btn.addEventListener("click", () => selectScene(s.id));
    host.appendChild(btn);
  }
}

function selectScene(scene: SceneId) {
  currentScene = scene;
  root.dataset.scene = scene;
  renderScenes();
  vscode.postMessage({ type: "scene", scene });
  if (audioEnabled && !paused && state) {
    lastCode = "";
    applyState(state, true);
  }
}

// --- live signal monitor -------------------------------------------------

interface RawEvent {
  ts: number;
  kind: string;
  tool?: string;
  source: "transcript" | "hooks" | "editor" | "composer";
  category?: string;
}

const RWINDOW = 12000;
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

  if (!prefersReduced) spawnFromEvent(ev);

  // Composer "typing" is a music-only pulse that shadows the "draft" event at
  // the same instant. Let it drive visuals, but not the pill/feed.
  if (ev.source === "composer" && ev.kind === "typing") return;
  if (ev.source in counts) {
    counts[ev.source]++;
    const pill = maybe(`src-${ev.source}`);
    if (pill) {
      const n = pill.querySelector(".n");
      if (n) n.textContent = String(counts[ev.source]);
      else {
        const name = SOURCE_PILL[ev.source] ?? ev.source;
        pill.textContent = `${name} ${counts[ev.source]}`;
      }
      pill.classList.add("hot");
      setTimeout(() => pill.classList.remove("hot"), 240);
    }
  }
  addFeedRow(ev);
}

function feedLabel(ev: RawEvent): string {
  if (ev.source === "composer" && (ev.kind === "draft" || ev.kind === "typing"))
    return "prompting";
  if (ev.tool) return `${ev.kind}:${ev.tool}`;
  return ev.kind;
}

function addFeedRow(ev: RawEvent) {
  const feed = $("feed");
  const row = document.createElement("div");
  row.className = `ev ${ev.source}`;
  const time = new Date(ev.ts).toLocaleTimeString("en-GB");
  row.innerHTML =
    `<span class="t">${time}</span>` +
    `<span class="k">${feedLabel(ev)}</span>` +
    `<span class="s">${ev.source}</span>`;
  feed.prepend(row);
  while (feed.childElementCount > 40) feed.lastElementChild?.remove();
}

// --- canvas helpers ------------------------------------------------------

function accent(): string {
  return getComputedStyle(root).getPropertyValue("--accent").trim() || "#ff8a3d";
}
function accent2(): string {
  return getComputedStyle(root).getPropertyValue("--accent-2").trim() || "#4a90d9";
}
function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace("#", ""), 16);
  const pb = parseInt(b.replace("#", ""), 16);
  const ar = (pa >> 16) & 255,
    ag = (pa >> 8) & 255,
    ab = pa & 255;
  const br = (pb >> 16) & 255,
    bg = (pb >> 8) & 255,
    bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function fitCanvas(
  c: HTMLCanvasElement,
  cssH: number,
): CanvasRenderingContext2D | null {
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.floor(c.clientWidth * dpr));
  c.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// Audio analyser helpers. Every scene program ends with `.analyze(1)`, so
// analyser id 1 carries the live master signal.
function timeData(): Float32Array | undefined {
  if (!audioEnabled || paused || typeof getAnalyzerData !== "function")
    return undefined;
  try {
    return getAnalyzerData("time", 1);
  } catch {
    return undefined;
  }
}
function freqData(): Float32Array | undefined {
  if (!audioEnabled || paused || typeof getAnalyzerData !== "function")
    return undefined;
  try {
    return getAnalyzerData("frequency", 1);
  } catch {
    return undefined;
  }
}

// --- scope: "Agent Aurora" -- the audio-reactive instrument --------------
// A flowing frequency aurora (real FFT once audio is on, synthesised from the
// conductor state until then) overlaid with "signal sparks": every agent event
// that feeds the music also blooms here as light, colour-coded by source.
// intensity -> amplitude+glow, tension -> red-shift+glitch, cps -> flow speed,
// activity -> spark density, voices -> orbiting motes, phase -> drop shockwave.

const scope = maybe("scope") as HTMLCanvasElement | null;
const SCOPE_H = 178;
const NS = 120; // aurora sample columns
const spec = new Float32Array(NS);
const specPhase = Array.from({ length: NS }, (_, c) => c * 0.5);
let sctx: CanvasRenderingContext2D | null = null;
let scopeW = 0;
const t0 = performance.now();
let prev = t0;

let palAcc = "#ff8a3d";
let palAcc2 = "#4a90d9";
let palTick = 0;
function refreshPalette() {
  palAcc = accent();
  palAcc2 = accent2();
}

const glowSprites = new Map<string, HTMLCanvasElement>();
function glowSprite(hex: string): HTMLCanvasElement {
  const cached = glowSprites.get(hex);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, hexA(hex, 1));
  grad.addColorStop(0.4, hexA(hex, 0.5));
  grad.addColorStop(1, hexA(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowSprites.set(hex, c);
  return c;
}
function drawGlow(x: number, y: number, r: number, hex: string, alpha: number) {
  if (!sctx || alpha <= 0 || r <= 0) return;
  sctx.globalAlpha = clamp01(alpha);
  sctx.drawImage(glowSprite(hex), x - r, y - r, r * 2, r * 2);
  sctx.globalAlpha = 1;
}

interface Spark {
  nx: number;
  ny: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
  color: string;
  grav: number;
}
const sparks: Spark[] = [];
const SPARK_MAX = 140;
interface Ring {
  x: number;
  y: number;
  t: number;
  ttl: number;
  color: string;
  w: number;
}
const rings: Ring[] = [];
interface Mote {
  ang: number;
  rad: number;
  spd: number;
}
const motes: Mote[] = [];
let glitchUntil = 0;
let bloom = 0;

const SOURCE_LANE: Record<string, [number, number]> = {
  composer: [0.04, 0.22],
  transcript: [0.18, 0.46],
  editor: [0.42, 0.72],
  hooks: [0.62, 0.96],
};
function laneX(source: string): number {
  const [a, b] = SOURCE_LANE[source] ?? [0.1, 0.9];
  return a + Math.random() * (b - a);
}

function addSpark(o: {
  nx: number;
  color: string;
  ny?: number;
  vx?: number;
  vy?: number;
  ttl?: number;
  size?: number;
  grav?: number;
}) {
  if (sparks.length >= SPARK_MAX) sparks.shift();
  sparks.push({
    nx: o.nx,
    ny: o.ny ?? 0.64,
    vx: o.vx ?? 0,
    vy: o.vy ?? -0.18,
    life: 0,
    ttl: o.ttl ?? 1.1,
    size: o.size ?? 7,
    color: o.color,
    grav: o.grav ?? 0.12,
  });
}

function spawnFromEvent(ev: RawEvent) {
  const col = SOURCE_COLOR[ev.source] || palAcc;
  const x = laneX(ev.source);
  switch (ev.kind) {
    case "thought":
      addSpark({ nx: x, color: col, vy: -0.12, ttl: 1.6, size: 5 });
      break;
    case "tool":
      for (let k = 0; k < 3; k++)
        addSpark({
          nx: x + (Math.random() - 0.5) * 0.04,
          color: col,
          vy: -0.22 - Math.random() * 0.2,
          vx: (Math.random() - 0.5) * 0.08,
          ttl: 1 + Math.random() * 0.5,
          size: 7 + Math.random() * 4,
        });
      break;
    case "tool-fail":
      glitchUntil = performance.now() + 260;
      rings.push({ x, y: 0.6, t: 0, ttl: 0.7, color: "#e0564a", w: 2.5 });
      for (let k = 0; k < 10; k++)
        addSpark({
          nx: x,
          color: "#e0564a",
          vy: -0.3 - Math.random() * 0.45,
          vx: (Math.random() - 0.5) * 0.55,
          ttl: 0.7 + Math.random() * 0.5,
          size: 8 + Math.random() * 6,
          grav: 0.3,
        });
      break;
    case "prompt":
    case "draft":
      for (let k = 0; k < 7; k++)
        addSpark({
          nx: 0.05 + k * 0.028,
          color: SOURCE_COLOR.composer,
          vy: -0.16 - Math.random() * 0.1,
          vx: 0.05,
          ttl: 1.4,
          size: 7,
        });
      break;
    case "typing":
      if (ev.source === "composer")
        addSpark({
          nx: laneX("composer"),
          color: SOURCE_COLOR.composer,
          vy: -0.1,
          ttl: 0.9,
          size: 4,
        });
      break;
    case "subagent-start":
      for (let k = 0; k < 6; k++)
        addSpark({
          nx: 0.5 + (Math.random() - 0.5) * 0.12,
          color: palAcc2,
          vy: -0.2 - Math.random() * 0.2,
          vx: (Math.random() - 0.5) * 0.3,
          ttl: 1,
          size: 7,
        });
      break;
    case "response":
      bloom = 1;
      rings.push({ x: 0.5, y: 0.58, t: 0, ttl: 1.1, color: palAcc, w: 3.5 });
      rings.push({ x: 0.5, y: 0.58, t: -0.14, ttl: 1.1, color: palAcc2, w: 2 });
      for (let k = 0; k < 30; k++) {
        const a = Math.random() * Math.PI * 2;
        addSpark({
          nx: 0.5,
          ny: 0.58,
          color: k % 2 ? palAcc : palAcc2,
          vx: Math.cos(a) * (0.2 + Math.random() * 0.55),
          vy: Math.sin(a) * (0.2 + Math.random() * 0.5) - 0.08,
          ttl: 0.9 + Math.random() * 0.7,
          size: 8 + Math.random() * 6,
          grav: 0.05,
        });
      }
      break;
    case "stop":
      for (let k = 0; k < 8; k++)
        addSpark({
          nx: Math.random(),
          ny: 0.28 + Math.random() * 0.2,
          color: palAcc,
          vy: 0.07 + Math.random() * 0.1,
          ttl: 1.6,
          size: 5,
          grav: -0.02,
        });
      break;
    default:
      addSpark({ nx: x, color: col, vy: -0.14, ttl: 1, size: 5 });
  }
}

function syncMotes(voices: number) {
  const want = Math.max(0, Math.min(3, voices - 1));
  while (motes.length < want)
    motes.push({
      ang: Math.random() * Math.PI * 2,
      rad: 0.5 + Math.random() * 0.4,
      spd: 0.8 + Math.random() * 0.6,
    });
  while (motes.length > want) motes.pop();
}

function setupScope() {
  if (!scope) return;
  sctx = fitCanvas(scope, SCOPE_H);
  scopeW = scope.clientWidth;
  refreshPalette();
}

function drawScope(now: number) {
  if (!scope || !sctx) return;
  const ctx = sctx;
  const w = scopeW || scope.clientWidth;
  const h = SCOPE_H;
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  const elapsed = (now - t0) / 1000;
  if (++palTick % 18 === 0) refreshPalette();

  const s = state;
  const i = s ? s.intensity : 0.12;
  const tn = s ? s.tension : 0;
  const cps = s ? s.cps : 0.5;
  const act = s ? s.activity : 0;
  bloom *= 0.92;

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(6,6,10,0.28)";
  ctx.fillRect(0, 0, w, h);

  const baseY = h * 0.64;
  {
    const g = ctx.createRadialGradient(
      w / 2,
      baseY,
      0,
      w / 2,
      baseY,
      h * (0.95 + bloom),
    );
    g.addColorStop(0, hexA(palAcc, 0.05 + i * 0.12 + bloom * 0.25));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  const fd = freqData();
  const usable = fd ? Math.floor(fd.length * 0.7) : 0;
  for (let c = 0; c < NS; c++) {
    const f = c / (NS - 1);
    let target: number;
    if (fd && usable > 0) {
      const bin = Math.min(usable - 1, Math.floor(Math.pow(f, 1.7) * usable));
      let db = fd[bin];
      if (!isFinite(db)) db = -100;
      target = clamp01((db + 100) / 70);
    } else {
      const profile = Math.pow(1 - f, 1.5) * 0.7 + 0.25;
      const wob =
        0.5 + 0.5 * Math.sin(elapsed * (1.2 + cps * 3) + specPhase[c] + f * 7);
      target = profile * (0.1 + i * 0.95) * (0.5 + 0.7 * wob);
    }
    target += tn * (Math.random() - 0.5) * 0.12 * f;
    target = clamp01(target);
    spec[c] += (target - spec[c]) * (target > spec[c] ? 0.5 : 0.12);
  }

  let bass = 0;
  const bn = Math.max(1, Math.floor(NS * 0.18));
  for (let c = 0; c < bn; c++) bass += spec[c];
  bass /= bn;

  const amp = h * (0.3 + i * 0.42) * (1 + bass * 0.5 + bloom * 0.4);
  const redShift = clamp01((tn - 0.3) * 1.6);
  const crest = redShift > 0 ? mix(palAcc, "#e0564a", redShift) : palAcc;

  ctx.globalCompositeOperation = "lighter";

  const RIB = 3;
  for (let r = RIB - 1; r >= 0; r--) {
    const ramp = 1 - r * 0.26;
    const off = r * 0.7 + elapsed * (0.25 + cps * 0.8);
    const col = r === 0 ? crest : mix(palAcc2, crest, r / RIB);
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (let c = 0; c < NS; c++) {
      const x = (c / (NS - 1)) * w;
      const wob = 1 + 0.12 * Math.sin(off + c * 0.2);
      const jitter = tn * (Math.random() - 0.5) * 6 * (c / NS);
      ctx.lineTo(x, baseY - spec[c] * amp * ramp * wob + jitter);
    }
    ctx.lineTo(w, baseY);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, baseY - amp, 0, baseY);
    g.addColorStop(0, hexA(col, 0));
    g.addColorStop(0.55, hexA(col, 0.12 * ramp));
    g.addColorStop(1, hexA(col, 0.3 * ramp));
    ctx.fillStyle = g;
    ctx.fill();
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = hexA(crest, 0.9);
  ctx.shadowColor = hexA(crest, 0.7);
  ctx.shadowBlur = 14;
  ctx.beginPath();
  for (let c = 0; c < NS; c++) {
    const x = (c / (NS - 1)) * w;
    const y = baseY - spec[c] * amp;
    c === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (redShift > 0.05) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA("#4a90d9", 0.4 * redShift);
    ctx.beginPath();
    for (let c = 0; c < NS; c++) {
      const x = (c / (NS - 1)) * w + redShift * 3;
      const y = baseY - spec[c] * amp;
      c === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = hexA(crest, 0.12);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c < NS; c++) {
    const x = (c / (NS - 1)) * w;
    const y = baseY + spec[c] * amp * 0.32;
    c === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  const td = timeData();
  if (td && td.length) {
    ctx.strokeStyle = hexA("#ffffff", 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(td.length / NS));
    let first = true;
    for (let idx = 0; idx < td.length; idx += step) {
      const x = (idx / (td.length - 1)) * w;
      const y = baseY - 5 - (td[idx] || 0) * h * 0.13;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  syncMotes(s ? s.voices : 1);
  drawGlow(
    w / 2,
    baseY,
    8 + i * 16 + bass * 22 + bloom * 30,
    palAcc,
    0.45 + bloom * 0.4,
  );
  for (const m of motes) {
    m.ang += dt * m.spd * (0.6 + cps);
    const mx = w / 2 + Math.cos(m.ang) * m.rad * w * 0.34;
    const my = baseY + Math.sin(m.ang) * m.rad * h * 0.3;
    drawGlow(mx, my, 5 + i * 4, palAcc2, 0.85);
  }

  for (let k = rings.length - 1; k >= 0; k--) {
    const ring = rings[k];
    ring.t += dt;
    if (ring.t < 0) continue;
    const p = ring.t / ring.ttl;
    if (p >= 1) {
      rings.splice(k, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(ring.x * w, ring.y * h, p * Math.max(w, h) * 0.55, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(ring.color, (1 - p) * 0.55);
    ctx.lineWidth = ring.w * (1 - p) + 0.5;
    ctx.stroke();
  }

  if (act > 0 && Math.random() < act * 0.4) {
    const lanes = ["transcript", "editor", "hooks"];
    const src = lanes[Math.floor(Math.random() * lanes.length)];
    addSpark({
      nx: laneX(src),
      color: SOURCE_COLOR[src],
      vy: -0.1 - Math.random() * 0.12,
      ttl: 1.2,
      size: 4,
    });
  }

  for (let k = sparks.length - 1; k >= 0; k--) {
    const sp = sparks[k];
    sp.life += dt;
    if (sp.life >= sp.ttl) {
      sparks.splice(k, 1);
      continue;
    }
    sp.vy += sp.grav * dt;
    sp.nx += sp.vx * dt;
    sp.ny += sp.vy * dt;
    const a = 1 - sp.life / sp.ttl;
    drawGlow(sp.nx * w, sp.ny * h, sp.size * (0.5 + a * 0.7), sp.color, a * 0.9);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.shadowBlur = 0;

  if (now < glitchUntil) {
    ctx.fillStyle = hexA("#e0564a", 0.12);
    ctx.fillRect(0, Math.random() * h, w, 2);
  }
}

// --- rhythm (live signals) ----------------------------------------------

const rhythm = maybe("rhythm") as HTMLCanvasElement | null;
const RHYTHM_H = 56;
let rctx: CanvasRenderingContext2D | null = null;

function setupRhythm() {
  if (!rhythm) return;
  rctx = fitCanvas(rhythm, RHYTHM_H);
}

function drawRhythm() {
  if (!rhythm || !rctx) return;
  const ctx = rctx;
  const w = rhythm.clientWidth;
  const h = RHYTHM_H;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w - 0.5, 0);
  ctx.lineTo(w - 0.5, h);
  ctx.stroke();

  const now = Date.now();
  while (events.length && now - events[0].ts > RWINDOW) events.shift();
  for (const ev of events) {
    const age = now - ev.ts;
    const x = w * (1 - age / RWINDOW);
    if (x < 0) continue;
    const weight =
      ev.kind === "tool-fail" || ev.kind === "response"
        ? 1
        : KIND_WEIGHT[ev.kind] ?? 0.4;
    const barH = 5 + weight * (h - 9);
    const alpha = 0.3 + 0.6 * (1 - age / RWINDOW);
    ctx.strokeStyle = hexA(
      ev.kind === "tool-fail" ? "#e0564a" : SOURCE_COLOR[ev.source] || "#888",
      alpha,
    );
    ctx.lineWidth = ev.kind === "tool-fail" || ev.kind === "response" ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x, h - barH);
    ctx.stroke();
  }
}

// --- raf loop ------------------------------------------------------------

let raf = 0;
function frame() {
  drawScope(performance.now());
  drawRhythm();
  raf = requestAnimationFrame(frame);
}

// --- audio: single Play / Pause toggle -----------------------------------

const toggleBtn = $("toggle") as HTMLButtonElement;
const liveTxt = $("live-txt");
const PLAY_ICON = "M8 5v14l11-7z";
const PAUSE_ICON = "M6 5h4v14H6zM14 5h4v14h-4z";

function setToggle(opts: {
  icon: "play" | "pause";
  label: string;
  state: string;
  disabled?: boolean;
}) {
  const path = toggleBtn.querySelector<SVGPathElement>(".vbtn__ico path");
  path?.setAttribute("d", opts.icon === "play" ? PLAY_ICON : PAUSE_ICON);
  const label = toggleBtn.querySelector(".label");
  if (label) label.textContent = opts.label;
  toggleBtn.dataset.state = opts.state;
  toggleBtn.disabled = !!opts.disabled;
  toggleBtn.setAttribute("aria-label", opts.label);
  toggleBtn.setAttribute("aria-pressed", String(opts.state === "playing"));
}

async function startPlayback() {
  if (audioEnabled) return;
  if (!audioReady) {
    setToggle({ icon: "pause", label: "Warming up…", state: "loading", disabled: true });
  }
  try {
    if (!audioReady) {
      await Promise.resolve(initStrudel({}));
      audioReady = true;
    }
    await Promise.resolve(getAudioContext?.()?.resume?.()).catch(() => {});
    audioEnabled = true;
    paused = false;
    root.classList.add("is-live");
    liveTxt.textContent = "live";
    setToggle({ icon: "pause", label: "Pause", state: "playing" });
    if (state) {
      lastCode = "";
      applyState(state, true);
    }
  } catch (err) {
    console.error("[agent-vibes-cursor] audio failed", err);
    setToggle({ icon: "play", label: "Retry", state: "" });
  }
}

function togglePause() {
  if (!audioReady || !audioEnabled) return;
  paused = !paused;
  const ctx = audioCtx();
  if (paused) {
    ctx?.suspend?.().catch(() => {});
    try {
      hush();
    } catch {
      /* ignore */
    }
    lastCode = "";
    root.classList.remove("is-live");
    liveTxt.textContent = "paused";
    setToggle({ icon: "play", label: "Resume", state: "paused" });
  } else {
    ctx?.resume?.().catch(() => {});
    root.classList.add("is-live");
    liveTxt.textContent = "live";
    setToggle({ icon: "pause", label: "Pause", state: "playing" });
    if (state) {
      lastCode = "";
      applyState(state, true);
    }
  }
}

function audioCtx(): AudioContext | undefined {
  try {
    return typeof getAudioContext === "function" ? getAudioContext() : undefined;
  } catch {
    return undefined;
  }
}

function toggleAudio() {
  if (!audioEnabled) startPlayback();
  else togglePause();
}

// --- diagnostics ---------------------------------------------------------

function updateDiag(data: Record<string, string>) {
  for (const key of ["transcript", "hooks", "composer"]) {
    const el = maybe(`diag-${key}`);
    if (el && data[key]) el.textContent = data[key];
  }
}

// --- messages from the extension -----------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "state") {
    applyState(msg.state as MusicalState);
  } else if (msg?.type === "event") {
    recordEvent(msg.event as RawEvent);
  } else if (msg?.type === "diag") {
    updateDiag(msg.data as Record<string, string>);
  } else if (msg?.type === "stop") {
    audioEnabled = false;
    paused = false;
    try {
      hush();
    } catch {
      /* ignore */
    }
    root.classList.remove("is-live");
    liveTxt.textContent = "ready";
    setToggle({ icon: "play", label: "Play", state: "" });
  }
});

// --- lifecycle -----------------------------------------------------------

toggleBtn.addEventListener("click", toggleAudio);
window.addEventListener("resize", () => {
  setupScope();
  setupRhythm();
});

renderScenes();
root.dataset.scene = currentScene;
setupScope();
setupRhythm();

if (!prefersReduced) raf = requestAnimationFrame(frame);
else {
  drawScope(performance.now());
  drawRhythm();
}
