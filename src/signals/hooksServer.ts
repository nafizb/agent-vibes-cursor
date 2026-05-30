import * as http from "node:http";
import { AgentEvent, categorize } from "../types";

/**
 * Tiny localhost listener for Cursor hook events. The installed hook scripts
 * POST the JSON stdin payload here. We only observe -- every response says
 * "continue" so we never block the agent.
 */
export class HooksServer {
  private server: http.Server | undefined;
  private listening = false;
  private received = 0;
  /** Collapse near-simultaneous duplicate tool pulses (e.g. preToolUse +
   * beforeReadFile for the same read) so the same action isn't counted twice. */
  private lastToolCat: string | undefined;
  private lastToolAt = 0;

  constructor(
    private readonly port: number,
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.listening = true;
        resolve();
      });
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.listening = false;
  }

  private isDuplicateTool(ev: AgentEvent): boolean {
    if (ev.kind !== "tool") return false;
    const cat = ev.category ?? "other";
    const dup = cat === this.lastToolCat && ev.ts - this.lastToolAt < 120;
    this.lastToolCat = cat;
    this.lastToolAt = ev.ts;
    return dup;
  }

  /** Human-readable status for the panel diagnostics footer. */
  status(): string {
    if (!this.listening) return `not listening on ${this.port}`;
    return this.received > 0
      ? `ok · :${this.port} · ${this.received} events`
      : `listening :${this.port} · install hooks + start a new chat`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ continue: true }));
      try {
        const payload = JSON.parse(body || "{}");
        const ev = mapHookEvent(payload);
        if (ev && !this.isDuplicateTool(ev)) {
          this.received++;
          this.onEvent(ev);
        }
      } catch {
        // ignore malformed payloads
      }
    });
  }
}

function mapHookEvent(payload: any): AgentEvent | undefined {
  const name: string | undefined = payload?.hook_event_name;
  if (!name) return undefined;
  const ts = Date.now();
  const tool: string | undefined = payload?.metadata?.tool_name;

  switch (name) {
    case "sessionStart":
      return {
        kind: "session-start",
        source: "hooks",
        ts,
        composerId: payload?.conversation_id ?? payload?.session_id,
      };
    case "beforeSubmitPrompt":
      return { kind: "prompt", source: "hooks", ts, text: payload?.prompt ?? payload?.text };
    case "afterAgentThought":
      return { kind: "thought", source: "hooks", ts, text: payload?.text };
    case "afterAgentResponse":
      return { kind: "response", source: "hooks", ts, text: payload?.text };
    case "postToolUseFailure":
      return { kind: "tool-fail", source: "hooks", ts, tool, category: categorize(tool) };
    case "subagentStart":
      return { kind: "subagent-start", source: "hooks", ts };
    case "subagentStop":
      return { kind: "subagent-stop", source: "hooks", ts };
    case "stop":
      return { kind: "stop", source: "hooks", ts };

    // --- The live "agent is working" stream -------------------------------
    // These granular hooks fire in real time on every action, which is what
    // makes the music move while the agent reads, runs commands and edits.
    case "preToolUse":
      // Generic: fires for every tool. tool_name drives the category.
      return { kind: "tool", source: "hooks", ts, tool, category: categorize(tool) };
    case "beforeReadFile":
      return { kind: "tool", source: "hooks", ts, tool: "Read", category: "research" };
    case "afterFileEdit":
      return { kind: "tool", source: "hooks", ts, tool: "Edit", category: "build" };
    case "beforeShellExecution":
      return { kind: "tool", source: "hooks", ts, tool: "Shell", category: "execute" };
    case "beforeMCPExecution":
      return { kind: "tool", source: "hooks", ts, tool: tool ?? "MCP", category: "mcp" };
    // postToolUse / afterShellExecution / afterMCPExecution are intentionally
    // skipped: the matching "before"/"preToolUse" pulse already covers them, and
    // counting both would double-trigger every action.
    default:
      return undefined;
  }
}
