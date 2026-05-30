export type SceneId = "cinematic" | "techno" | "lofi" | "chiptune";

export type Phase =
  | "idle" // session open, nothing happening
  | "prompting" // user submitted a prompt, agent spinning up
  | "thinking" // agent producing thoughts
  | "working" // tools firing
  | "drop" // response streaming -- the climax
  | "resolve"; // stop -- winding down

/** Broad category a tool falls into, used to color the music. */
export type ToolCategory =
  | "research" // Read / Grep / Glob / ReadLints
  | "execute" // Shell / AwaitShell
  | "build" // Write / StrReplace / Delete / EditNotebook
  | "plan" // TodoWrite
  | "subagent" // Task
  | "mcp" // CallMcpTool / FetchMcpResource
  | "other";

export type EventKind =
  | "session-start"
  | "prompt"
  | "thought"
  | "tool"
  | "tool-fail"
  | "response"
  | "stop"
  | "subagent-start"
  | "subagent-stop"
  | "typing"
  | "draft"; // live chat-composer draft (read from state.vscdb)

export interface AgentEvent {
  kind: EventKind;
  source: "transcript" | "hooks" | "editor" | "composer";
  ts: number;
  tool?: string;
  category?: ToolCategory;
  /** Prompt or response text, when available -- used for content analysis. */
  text?: string;
  /** sessionStart hook: the new composer/conversation id to watch for drafts. */
  composerId?: string;
}

/**
 * Continuous musical state. The conductor smoothly interpolates the live values
 * toward per-event targets so the music breathes instead of jerking.
 */
export interface MusicalState {
  scene: SceneId;
  phase: Phase;
  intensity: number; // 0..1 -- drum gain, voice count, brightness
  tension: number; // 0..1 -- dissonance, narrowed filter
  cps: number; // cycles per second (tempo)
  activity: number; // 0..1 -- recent event rate (momentum)
  voices: number; // active parallel voices (subagents)
  /** Per-session randomness for the "hybrid" feel: fixed scene, fresh details. */
  seed: number;
  key: string; // tonic note, e.g. "c"
  mode: string; // scale mode, e.g. "minor"
  /** Monotonic revision so the webview can ignore stale frames. */
  rev: number;
}

export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  Read: "research",
  Grep: "research",
  Glob: "research",
  ReadLints: "research",
  Shell: "execute",
  AwaitShell: "execute",
  Write: "build",
  StrReplace: "build",
  Delete: "build",
  EditNotebook: "build",
  TodoWrite: "plan",
  Task: "subagent",
  CallMcpTool: "mcp",
  FetchMcpResource: "mcp",
};

export function categorize(tool: string | undefined): ToolCategory {
  if (!tool) return "other";
  return TOOL_CATEGORY[tool] ?? "other";
}
