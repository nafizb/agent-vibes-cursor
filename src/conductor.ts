import { AgentEvent, MusicalState, Phase, SceneId, categorize } from "./types";

const MODES_BY_SCENE: Record<SceneId, string[]> = {
  cinematic: ["minor", "dorian", "aeolian", "phrygian"],
  techno: ["minor", "phrygian", "locrian"],
  lofi: ["dorian", "major", "mixolydian", "lydian"],
  chiptune: ["major", "mixolydian", "lydian", "minor"],
  piano: ["minor", "aeolian", "dorian", "lydian"],
  jazz: ["dorian", "mixolydian", "aeolian", "lydian"],
};

const KEYS = ["c", "d", "e", "f", "g", "a"];

const CPS_RANGE: Record<SceneId, [number, number]> = {
  cinematic: [0.45, 0.85],
  techno: [0.55, 0.95],
  lofi: [0.42, 0.62],
  chiptune: [0.6, 1.0],
  piano: [0.38, 0.66],
  jazz: [0.46, 0.74],
};

interface Targets {
  intensity: number;
  tension: number;
  cps: number;
}

export interface ConductorOptions {
  scene: SceneId;
  onState: (state: MusicalState) => void;
  /** ms between interpolation ticks. */
  tickMs?: number;
}

/**
 * The musical brain. Normalised agent events nudge a set of targets; a tick loop
 * eases the live values toward those targets so transitions feel composed.
 * Holds no VS Code or audio dependencies so it can be unit-tested in isolation.
 */
export class Conductor {
  private state: MusicalState;
  private targets: Targets;
  private recentEvents: number[] = []; // timestamps for momentum
  private lastEventAt = Date.now();
  private lastDraftLen = 0; // for typing-velocity estimation
  private lastDraftAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly tickMs: number;
  private readonly onState: (s: MusicalState) => void;

  constructor(opts: ConductorOptions) {
    this.tickMs = opts.tickMs ?? 100;
    this.onState = opts.onState;
    const seed = Math.floor(Math.random() * 1e9);
    this.state = {
      scene: opts.scene,
      phase: "idle",
      intensity: 0.12,
      tension: 0,
      cps: CPS_RANGE[opts.scene][0],
      activity: 0,
      voices: 1,
      seed,
      key: KEYS[seed % KEYS.length],
      mode: MODES_BY_SCENE[opts.scene][seed % MODES_BY_SCENE[opts.scene].length],
      rev: 0,
    };
    this.targets = {
      intensity: this.state.intensity,
      tension: 0,
      cps: this.state.cps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.emit();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Switch scene live without losing the running session feel. */
  setScene(scene: SceneId): void {
    this.state.scene = scene;
    const [min] = CPS_RANGE[scene];
    this.state.mode = MODES_BY_SCENE[scene][this.state.seed % MODES_BY_SCENE[scene].length];
    this.targets.cps = Math.max(this.targets.cps, min);
    this.emit();
  }

  getState(): MusicalState {
    return { ...this.state };
  }

  /** Feed a normalised agent event into the machine. */
  push(ev: AgentEvent): void {
    const now = ev.ts || Date.now();
    this.lastEventAt = now;
    const [cpsMin, cpsMax] = CPS_RANGE[this.state.scene];

    switch (ev.kind) {
      case "session-start":
        this.setPhase("idle");
        this.targets.intensity = 0.12;
        this.targets.tension = 0;
        break;

      case "prompt":
        this.setPhase("prompting");
        this.applyPromptText(ev.text);
        this.bump("intensity", 0.18);
        break;

      case "thought":
        this.setPhase("thinking");
        this.bump("intensity", 0.06);
        break;

      case "tool": {
        this.setPhase("working");
        this.recentEvents.push(now);
        const cat = ev.category ?? categorize(ev.tool);
        // Each tool category pushes the music differently.
        if (cat === "build") this.bump("intensity", 0.14);
        else if (cat === "execute") this.bump("intensity", 0.08);
        else if (cat === "research") this.bump("intensity", 0.05);
        else if (cat === "plan") this.bump("intensity", 0.04);
        else this.bump("intensity", 0.05);
        // Momentum lifts tempo.
        this.targets.cps = clamp(this.targets.cps + 0.01, cpsMin, cpsMax);
        break;
      }

      case "tool-fail":
        this.bump("tension", 0.35);
        this.bump("intensity", 0.05);
        break;

      case "subagent-start":
        this.state.voices = Math.min(4, this.state.voices + 1);
        this.bump("intensity", 0.08);
        break;

      case "subagent-stop":
        this.state.voices = Math.max(1, this.state.voices - 1);
        break;

      case "response":
        this.setPhase("drop");
        this.targets.intensity = Math.max(this.targets.intensity, 0.9);
        this.targets.cps = clamp(cpsMax, cpsMin, cpsMax);
        break;

      case "stop":
        this.setPhase("resolve");
        this.targets.intensity = 0.18;
        this.targets.tension = 0;
        break;

      case "typing":
        // Micro-feedback while you write (code files or chat composer).
        this.recentEvents.push(now);
        if (ev.source === "composer") {
          this.setPhase("prompting");
          this.bump("intensity", 0.028);
        } else {
          this.bump("intensity", 0.015);
        }
        break;

      case "draft": {
        // Live chat-composer draft: "mix music while writing the prompt".
        this.setPhase("prompting");
        this.recentEvents.push(now);
        const len = ev.text?.length ?? 0;

        // Draft length sets a baseline energy floor (longer prompt => more drive).
        const floor = clamp(0.2 + (len / 600) * 0.4, 0.2, 0.7);
        this.targets.intensity = Math.max(this.targets.intensity, floor);

        // Typing *velocity* drives tempo + a little extra energy, so fast typing
        // accelerates the music and pauses let it breathe.
        const dt = this.lastDraftAt ? now - this.lastDraftAt : 0;
        const dChars = len - this.lastDraftLen;
        if (dt > 0 && dChars > 0) {
          const cps = dChars / (dt / 1000); // characters per second
          this.targets.cps = clamp(this.targets.cps + Math.min(0.025, cps * 0.0015), cpsMin, cpsMax);
          this.bump("intensity", clamp(cps * 0.003, 0, 0.06));
        }
        this.lastDraftLen = len;
        this.lastDraftAt = now;

        if (ev.text && /\b(fix|bug|error|fail|crash|urgent|broken|wrong|debug)\b/i.test(ev.text)) {
          this.bump("tension", 0.12);
        }
        break;
      }
    }
  }

  // --- internals ---------------------------------------------------------

  private applyPromptText(text?: string): void {
    if (!text) return;
    const len = text.length;
    // Longer / denser prompts => a touch more drive from the outset.
    const lenFactor = clamp(len / 800, 0, 1);
    this.targets.intensity = clamp(0.3 + lenFactor * 0.25, 0, 1);
    // Crude sentiment: urgency / trouble words add starting tension.
    const tense = /\b(fix|bug|error|fail|crash|urgent|broken|wrong|debug)\b/i.test(text);
    if (tense) this.bump("tension", 0.2);
  }

  private bump(field: "intensity" | "tension", amount: number): void {
    this.targets[field] = clamp(this.targets[field] + amount, 0, 1);
  }

  private setPhase(phase: Phase): void {
    this.state.phase = phase;
  }

  private tick(): void {
    const now = Date.now();
    const sinceEvent = now - this.lastEventAt;

    // Momentum: events in the last 6s, normalised.
    this.recentEvents = this.recentEvents.filter((t) => now - t < 6000);
    this.state.activity = clamp(this.recentEvents.length / 8, 0, 1);

    // Long silence while working builds suspense; otherwise everything decays.
    if (sinceEvent > 4000 && (this.state.phase === "working" || this.state.phase === "thinking")) {
      this.targets.tension = clamp(this.targets.tension + 0.004, 0, 0.7);
    } else {
      this.targets.tension = clamp(this.targets.tension - 0.01, 0, 1);
    }
    if (sinceEvent > 2500) {
      this.targets.intensity = clamp(this.targets.intensity - 0.006, 0.1, 1);
      const [cpsMin] = CPS_RANGE[this.state.scene];
      this.targets.cps = clamp(this.targets.cps - 0.004, cpsMin, this.targets.cps);
    }
    if (sinceEvent > 12000 && this.state.phase !== "idle") {
      this.setPhase("idle");
    }

    // Ease live values toward targets (critically damped feel).
    const k = 0.12;
    this.state.intensity = lerp(this.state.intensity, this.targets.intensity, k);
    this.state.tension = lerp(this.state.tension, this.targets.tension, k);
    this.state.cps = lerp(this.state.cps, this.targets.cps, k * 0.6);

    this.emit();
  }

  private emit(): void {
    this.state.rev++;
    this.onState({ ...this.state });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
