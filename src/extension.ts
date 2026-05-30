import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Conductor } from "./conductor";
import { HooksServer } from "./signals/hooksServer";
import { TranscriptTail } from "./signals/transcript";
import { TypingSignal } from "./signals/typing";
import { DraftWatcher } from "./signals/draftWatcher";
import { SceneId } from "./types";

let panel: vscode.WebviewPanel | undefined;
let conductor: Conductor | undefined;
let hooks: HooksServer | undefined;
let transcript: TranscriptTail | undefined;
let typing: TypingSignal | undefined;
let draft: DraftWatcher | undefined;

const HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "afterAgentThought",
  "afterAgentResponse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "stop",
  // Granular "agent is working" stream -- the live pulse while it reads, runs
  // commands and edits files.
  "preToolUse",
  "beforeReadFile",
  "afterFileEdit",
  "beforeShellExecution",
  "beforeMCPExecution",
];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("agentVibes.start", () => start(context)),
    vscode.commands.registerCommand("agentVibes.stop", () => stop()),
    vscode.commands.registerCommand("agentVibes.installHooks", () => installHooks()),
  );
  // Auto-open the panel so the user sees it without hunting for the command.
  // (Audio itself still needs one click due to the browser autoplay policy.)
  start(context).catch((err) => console.error("[agent-vibes-cursor] start failed", err));

  // Auto-wire Cursor hooks on first run so failure/stop cues work without a
  // manual step. Idempotent; only notifies when it actually changes hooks.json.
  try {
    const changed = ensureHooks();
    if (changed) {
      vscode.window.showInformationMessage(
        "Agent Vibes: Cursor hooks installed. Start a NEW agent chat for failure/stop cues to take effect.",
      );
    }
  } catch (err) {
    console.warn("[agent-vibes-cursor] auto hook install failed", err);
  }
}

export function deactivate() {
  stop();
}

function config() {
  return vscode.workspace.getConfiguration("agentVibes");
}

async function start(context: vscode.ExtensionContext) {
  const scene = config().get<SceneId>("scene", "cinematic");
  const port = config().get<number>("hooksPort", 7777);

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "agentVibes",
      "Agent Vibes",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    panel.webview.html = getHtml(panel.webview, context.extensionUri, scene);
    panel.onDidDispose(() => {
      panel = undefined;
      stop();
    });
    panel.webview.onDidReceiveMessage((msg) => onWebviewMessage(msg));
  } else {
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  if (!conductor) {
    conductor = new Conductor({
      scene,
      onState: (state) => panel?.webview.postMessage({ type: "state", state }),
    });
    conductor.start();
  }

  // Signal sources. Every event both drives the conductor and is mirrored to
  // the panel's live signal monitor.
  if (!hooks) {
    hooks = new HooksServer(port, dispatch);
    try {
      await hooks.start();
    } catch (err) {
      vscode.window.showWarningMessage(
        `Agent Vibes: hooks port ${port} unavailable (${String(err)}). Transcript signal still active.`,
      );
      hooks = undefined;
    }
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root && !transcript) {
    transcript = new TranscriptTail(root, dispatch);
    transcript.start();
  }

  if (!typing) {
    typing = new TypingSignal(dispatch);
    typing.start();
  }

  // Experimental: read the chat composer draft from Cursor's SQLite stores.
  // Note: not gated on `root` -- the chat you type in is often an unbound
  // composer, and the watcher discovers the active draft globally.
  if (!draft && config().get<boolean>("experimentalChatDraft", true)) {
    const globalStorageDir = cursorGlobalStorageDir(context);
    draft = new DraftWatcher(root ?? "", globalStorageDir, dispatch);
    draft.start();
    if (!draft.isAvailable()) {
      console.warn(`[agent-vibes-cursor] chat-draft watcher unavailable: ${draft.status()}`);
    }
  }

  startDiagnostics();
}

/**
 * Locate Cursor's real global storage directory (the one holding state.vscdb).
 * `context.globalStorageUri` is preferred, but an Extension Development Host can
 * resolve it to a different user-data dir, so we verify state.vscdb is present
 * and otherwise fall back to the standard per-OS Cursor location.
 */
function cursorGlobalStorageDir(context: vscode.ExtensionContext): string {
  const fromCtx = path.dirname(context.globalStorageUri.fsPath);
  if (fs.existsSync(path.join(fromCtx, "state.vscdb"))) return fromCtx;

  const home = os.homedir();
  const candidates = [
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
    path.join(home, ".config", "Cursor", "User", "globalStorage"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "Cursor", "User", "globalStorage") : "",
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "state.vscdb"))) return dir;
  }
  return fromCtx;
}

let diagTimer: NodeJS.Timeout | undefined;

/** Push a compact status of every signal source to the panel's footer. */
function startDiagnostics() {
  if (diagTimer) return;
  const tick = () => {
    panel?.webview.postMessage({
      type: "diag",
      data: {
        transcript: transcript?.status() ?? "off",
        hooks: hooks?.status() ?? "off (port busy)",
        composer: draft?.status() ?? "off",
      },
    });
  };
  tick();
  diagTimer = setInterval(tick, 2000);
}

/** Feed an event to the conductor and mirror it to the live signal monitor. */
function dispatch(ev: import("./types").AgentEvent) {
  if (ev.kind === "session-start" && ev.composerId) {
    draft?.pinComposer(ev.composerId);
  }
  conductor?.push(ev);
  panel?.webview.postMessage({ type: "event", event: ev });
}

function stop() {
  panel?.webview.postMessage({ type: "stop" });
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = undefined;
  conductor?.dispose();
  conductor = undefined;
  hooks?.dispose();
  hooks = undefined;
  transcript?.dispose();
  transcript = undefined;
  typing?.dispose();
  typing = undefined;
  draft?.dispose();
  draft = undefined;
}

function onWebviewMessage(msg: any) {
  switch (msg?.type) {
    case "scene": {
      const scene = msg.scene as SceneId;
      config().update("scene", scene, vscode.ConfigurationTarget.Global);
      conductor?.setScene(scene);
      break;
    }
    case "panic":
      stop();
      break;
  }
}

/**
 * Write the forwarder script and merge our hook entries into ~/.cursor/hooks.json.
 * Idempotent and side-effect-light: returns true only if hooks.json was changed.
 * Throws on unrecoverable IO errors (caller decides how loud to be).
 */
function ensureHooks(): boolean {
  const port = config().get<number>("hooksPort", 7777);
  const cursorDir = path.join(os.homedir(), ".cursor");
  const hookDir = path.join(cursorDir, "agent-vibes-cursor-hooks");
  const scriptPath = path.join(hookDir, "send.sh");
  const hooksJsonPath = path.join(cursorDir, "hooks.json");

  fs.mkdirSync(hookDir, { recursive: true });
  const script = `#!/usr/bin/env bash
# Auto-generated by the Agent Vibes extension. Forwards Cursor hook payloads
# (received on stdin) to the local Agent Vibes listener.
payload="$(cat)"
curl -s -m 1 -X POST "http://127.0.0.1:${port}/event" \\
  -H 'Content-Type: application/json' \\
  -d "$payload" >/dev/null 2>&1 || true
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  let existing: any = { version: 1, hooks: {} };
  let parseFailed = false;
  if (fs.existsSync(hooksJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8")) || existing;
    } catch {
      parseFailed = true; // don't silently clobber a user's invalid file
    }
  }
  if (parseFailed) throw new Error("~/.cursor/hooks.json is not valid JSON");

  existing.version = existing.version ?? 1;
  existing.hooks = existing.hooks ?? {};

  let changed = false;
  for (const ev of HOOK_EVENTS) {
    const list: any[] = Array.isArray(existing.hooks[ev]) ? existing.hooks[ev] : [];
    if (!list.some((h) => h?.command === scriptPath)) {
      list.push({ command: scriptPath });
      changed = true;
    }
    existing.hooks[ev] = list;
  }

  if (changed) fs.writeFileSync(hooksJsonPath, JSON.stringify(existing, null, 2));
  return changed;
}

async function installHooks() {
  const hooksJsonPath = path.join(os.homedir(), ".cursor", "hooks.json");
  try {
    const changed = ensureHooks();
    vscode.window.showInformationMessage(
      changed
        ? `Agent Vibes hooks installed to ${hooksJsonPath}. Start a new agent chat to activate.`
        : "Agent Vibes hooks already installed. Start a new agent chat if cues aren't firing.",
    );
  } catch (err) {
    const overwrite = await vscode.window.showWarningMessage(
      `${String(err)}. Overwrite ~/.cursor/hooks.json?`,
      "Overwrite",
      "Cancel",
    );
    if (overwrite !== "Overwrite") return;
    fs.rmSync(hooksJsonPath, { force: true });
    try {
      ensureHooks();
      vscode.window.showInformationMessage("Agent Vibes hooks installed. Start a new agent chat to activate.");
    } catch (e) {
      vscode.window.showErrorMessage(`Agent Vibes: could not install hooks (${String(e)}).`);
    }
  }
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, scene: SceneId): string {
  const distUri = vscode.Uri.joinPath(extensionUri, "dist");
  const strudelUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "strudel", "index.js"));
  const mainUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // Strudel transpiles + builds worklets at runtime, hence eval/wasm/blob.
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} blob: data: https:`,
    `media-src ${webview.cspSource} blob: data: https:`,
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: dark; }
  body { font-family: var(--vscode-font-family); margin: 0; padding: 16px; color: var(--vscode-foreground); }
  h1 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em; opacity: .7; margin: 0 0 12px; }
  .scenes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
  .scene { padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; cursor: pointer; background: transparent; color: inherit; text-align: left; }
  .scene.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
  .scene b { display: block; font-size: 13px; }
  .scene span { font-size: 11px; opacity: .6; }
  .meters { display: grid; gap: 8px; margin: 16px 0; }
  .meter label { font-size: 11px; opacity: .7; display: flex; justify-content: space-between; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-input-background); overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0%; background: var(--vscode-progressBar-background); transition: width .1s linear; }
  .bar.tension > i { background: #e0564a; }
  #phase { font-size: 12px; opacity: .8; margin-top: 8px; }
  button.primary { width: 100%; padding: 10px; border: 0; border-radius: 8px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px; }
  .hint { font-size: 11px; opacity: .55; margin-top: 12px; line-height: 1.5; }
  #vu { width: 100%; height: 22px; display: block; margin-top: 12px; border-radius: 4px; }
  .section { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; opacity: .55; margin: 18px 0 8px; }
  #rhythm { width: 100%; height: 64px; display: block; background: var(--vscode-input-background); border-radius: 6px; }
  .sources { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
  .src { font-size: 10px; padding: 3px 8px; border-radius: 999px; background: var(--vscode-input-background); opacity: .5; transition: opacity .15s, background .15s; }
  .src.hot { opacity: 1; }
  .src.transcript.hot { background: #4a90d9; }
  .src.hooks.hot { background: #e0564a; }
  .src.editor.hot { background: #4ac06b; }
  .src.composer.hot { background: #b48ce0; }
  #feed { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; line-height: 1.7; max-height: 150px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; }
  .ev { display: flex; gap: 8px; white-space: nowrap; }
  .ev .t { opacity: .45; }
  .ev .k { font-weight: 600; }
  .ev .s { margin-left: auto; opacity: .5; }
  .ev.transcript .k { color: #6ab0ff; }
  .ev.hooks .k { color: #ff8478; }
  .ev.editor .k { color: #6fe08f; }
  .ev.composer .k { color: #cda9f5; }
  .diag { font-size: 10.5px; display: grid; gap: 4px; }
  .diag .drow { display: flex; justify-content: space-between; gap: 10px; }
  .diag .drow > span { opacity: .55; }
  .diag .drow > b { font-weight: 500; opacity: .85; text-align: right; font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
  <h1>Agent Vibes</h1>
  <button id="enable" class="primary">▶ Enable audio</button>
  <button id="pause" class="primary" style="display:none; margin-top:8px; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground)">⏸ Pause</button>
  <canvas id="vu" title="Output level"></canvas>
  <div class="scenes" id="scenes"></div>
  <div class="meters">
    <div class="meter"><label>Intensity <span id="iVal">0</span></label><div class="bar"><i id="iBar"></i></div></div>
    <div class="meter"><label>Tension <span id="tVal">0</span></label><div class="bar tension"><i id="tBar"></i></div></div>
    <div class="meter"><label>Tempo <span id="cVal">0</span> cps</label><div class="bar"><i id="cBar"></i></div></div>
  </div>
  <div id="phase">phase: idle</div>

  <div class="section">Live signals</div>
  <canvas id="rhythm"></canvas>
  <div class="sources">
    <span class="src transcript" id="src-transcript">transcript 0</span>
    <span class="src hooks" id="src-hooks">hooks 0</span>
    <span class="src editor" id="src-editor" title="Typing in code files">files 0</span>
    <span class="src composer" id="src-composer" title="Typing in agent chat box">prompt 0</span>
  </div>
  <div id="feed"></div>

  <div class="section">Diagnostics</div>
  <div class="diag" id="diag">
    <div class="drow"><span>transcript</span><b id="diag-transcript">…</b></div>
    <div class="drow"><span>hooks</span><b id="diag-hooks">…</b></div>
    <div class="drow"><span>composer</span><b id="diag-composer">…</b></div>
  </div>

  <div class="hint">Chat prompt typing → purple prompt pill. Code file typing → green files pill. Hooks fire on Enter and agent actions.</div>
  <script nonce="${nonce}">window.__VIBE__ = { scene: ${JSON.stringify(scene)} };</script>
  <script nonce="${nonce}" src="${strudelUri}"></script>
  <script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
