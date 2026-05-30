import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentEvent, categorize } from "../types";

/**
 * Tails the *currently active* Cursor agent transcript JSONL.
 *
 * Cursor stores transcripts at:
 *   ~/.cursor/projects/<slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 *
 * IMPORTANT: <slug> is NOT reliably derivable from the workspace path. Depending
 * on how the window was opened, Cursor uses the path-based slug
 * (`Users-me-Dev-proj`), a temp-dir slug (`var-folders-…`), or `ext-dev` for an
 * Extension Development Host. So deriving the folder from `workspaceRoot` watches
 * the wrong (often dead) session and no events ever fire.
 *
 * Instead we follow the *globally newest* transcript across every project folder
 * and re-check periodically, so the music tracks whatever agent is actually
 * running -- regardless of how Cursor named the project.
 *
 * Each line is `{role:"user"|"assistant", message:{content:[...]}}`. We extract
 * prompt text, agent thoughts/text, and the stream of tool_use names.
 */
const SCAN_MS = 1000;

export class TranscriptTail {
  private projectsDir: string;
  private activeFile: string | undefined;
  private offset = 0;
  private pending = "";
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {
    this.projectsDir = path.join(os.homedir(), ".cursor", "projects");
  }

  start(): void {
    this.tick();
    this.poll = setInterval(() => this.tick(), SCAN_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Human-readable status for the panel diagnostics footer. */
  status(): string {
    if (!this.activeFile) return "waiting for an agent session…";
    const id = path.basename(this.activeFile, ".jsonl");
    const proj = this.activeFile.split(path.sep).slice(-4, -3)[0] ?? "";
    return `tailing ${id.slice(0, 8)} (${proj})`;
  }

  private tick(): void {
    if (this.disposed) return;
    this.switchToNewest();
    this.readNew();
  }

  private switchToNewest(): void {
    const newest = newestJsonlGlobal(this.projectsDir);
    if (newest && newest.file !== this.activeFile) {
      this.activeFile = newest.file;
      // Start at the end of file: we only react to events from "now" on, and we
      // avoid replaying an entire prior conversation as one burst.
      this.offset = newest.size;
      this.pending = "";
    }
  }

  private readNew(): void {
    if (!this.activeFile) return;
    let size: number;
    try {
      size = fs.statSync(this.activeFile).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // File truncated/rotated.
      this.offset = 0;
      this.pending = "";
    }
    if (size === this.offset) return;

    let fd: number;
    try {
      fd = fs.openSync(this.activeFile, "r");
    } catch {
      return;
    }
    try {
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      this.pending += buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    const lines = this.pending.split("\n");
    // Keep the trailing (possibly incomplete) line for next read.
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const role = obj?.role;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) return;
    const now = Date.now();

    if (role === "user") {
      const text = content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) this.onEvent({ kind: "prompt", source: "transcript", ts: now, text });
      return;
    }

    if (role === "assistant") {
      for (const c of content) {
        if (c?.type === "tool_use" && c.name) {
          this.onEvent({
            kind: "tool",
            source: "transcript",
            ts: now,
            tool: c.name,
            category: categorize(c.name),
          });
        } else if (c?.type === "text" && c.text?.trim()) {
          this.onEvent({ kind: "thought", source: "transcript", ts: now, text: c.text });
        }
      }
    }
  }
}

/** Legacy helper kept for reference: the path-derived slug (no longer relied on). */
export function transcriptDirFor(workspaceRoot: string): string {
  const slug = workspaceRoot.replace(/^\//, "").replace(/\//g, "-");
  return path.join(os.homedir(), ".cursor", "projects", slug, "agent-transcripts");
}

/**
 * Find the most-recently-modified `<id>/<id>.jsonl` under any
 * `~/.cursor/projects/<slug>/agent-transcripts/` folder.
 */
function newestJsonlGlobal(projectsDir: string): { file: string; size: number } | undefined {
  let best: { file: string; size: number } | undefined;
  let bestMtime = -1;

  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(projectsDir, proj.name, "agent-transcripts");
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // no agent-transcripts in this project
    }
    for (const ses of sessions) {
      if (!ses.isDirectory()) continue;
      const file = path.join(dir, ses.name, `${ses.name}.jsonl`);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = { file, size: st.size };
        }
      } catch {
        // session folder without a matching jsonl yet
      }
    }
  }
  return best;
}
