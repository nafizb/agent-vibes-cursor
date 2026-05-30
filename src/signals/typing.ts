import * as vscode from "vscode";
import { AgentEvent } from "../types";

/**
 * Maps your own typing in open editors to gentle "typing" events. The Cursor
 * chat composer is not observable by any API, so this covers typing in files
 * (notes, scratch buffers, code) as a proxy for "you are actively writing".
 */
export class TypingSignal {
  private sub: vscode.Disposable | undefined;
  private lastEmit = 0;

  constructor(private readonly onEvent: (ev: AgentEvent) => void) {}

  start(): void {
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      // Real editor buffers only; skip output/log/debug consoles etc.
      const scheme = e.document.uri.scheme;
      if (scheme !== "file" && scheme !== "untitled") return;
      const now = Date.now();
      // Throttle: one pulse per ~120ms of typing.
      if (now - this.lastEmit < 120) return;
      this.lastEmit = now;
      this.onEvent({ kind: "typing", source: "editor", ts: now });
    });
  }

  dispose(): void {
    this.sub?.dispose();
  }
}
