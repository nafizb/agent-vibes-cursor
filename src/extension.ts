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

  const phases = ["idle", "prompting", "thinking", "working", "drop", "resolve"];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  /* Per-scene accents tween smoothly when the scene flips (Chromium webview). */
  @property --accent { syntax: "<color>"; inherits: true; initial-value: #ff8a3d; }
  @property --accent-2 { syntax: "<color>"; inherits: true; initial-value: #4a90d9; }

  :root {
    color-scheme: dark;
    --bg: #07070a;
    --bg-2: #0b0b13;
    --surface: rgba(255, 255, 255, 0.025);
    --surface-2: rgba(255, 255, 255, 0.045);
    --line: rgba(255, 255, 255, 0.09);
    --line-2: rgba(255, 255, 255, 0.14);
    --fg: rgba(255, 255, 255, 0.94);
    --muted: rgba(255, 255, 255, 0.62);
    --faint: rgba(255, 255, 255, 0.4);
    --blue: #4a90d9;
    --red: #e0564a;
    --green: #4ac06b;
    --purple: #b48ce0;
    --accent: #ff8a3d;
    --accent-2: #4a90d9;
    --accent-rgb: 255, 138, 61;
    --font-sans: var(--vscode-font-family), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: var(--vscode-editor-font-family), ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  [data-scene="cinematic"] { --accent: #ff8a3d; --accent-2: #4a90d9; --accent-rgb: 255, 138, 61; }
  [data-scene="techno"] { --accent: #e0564a; --accent-2: #ff2d6b; --accent-rgb: 224, 86, 74; }
  [data-scene="lofi"] { --accent: #b48ce0; --accent-2: #f6b59b; --accent-rgb: 180, 140, 224; }
  [data-scene="chiptune"] { --accent: #4ac06b; --accent-2: #a6e85a; --accent-rgb: 74, 192, 107; }
  [data-scene="piano"] { --accent: #ffffff; --accent-2: #aeb4c0; --accent-rgb: 255, 255, 255; }
  [data-scene="jazz"] { --accent: #e3a948; --accent-2: #5aa6b8; --accent-rgb: 227, 169, 72; }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    line-height: 1.5;
  }

  .console {
    position: relative;
    width: 100%;
    max-width: 520px;
    margin-inline: auto;
    border-radius: 1.1rem;
    padding: 1rem;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
      var(--bg-2);
    border: 1px solid var(--line-2);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 30px 70px -40px rgba(0, 0, 0, 0.8),
      0 0 70px -50px rgba(var(--accent-rgb), 0.8);
    transition: box-shadow 0.4s ease, --accent 700ms cubic-bezier(0.4,0,0.2,1), --accent-2 700ms cubic-bezier(0.4,0,0.2,1);
  }
  .console.is-live {
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 30px 70px -40px rgba(0, 0, 0, 0.8),
      0 0 80px -36px rgba(var(--accent-rgb), 1);
  }
  .console[data-phase="drop"] {
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.08) inset,
      0 30px 80px -38px rgba(0, 0, 0, 0.85),
      0 0 100px -28px rgba(var(--accent-rgb), 1);
  }

  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.8rem; padding-inline: 0.2rem; }
  .brand { display: inline-flex; align-items: center; gap: 0.55rem; font-weight: 600; font-size: 0.98rem; letter-spacing: -0.01em; }
  .brand__amp { color: var(--muted); font-weight: 500; }
  .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 1.05em; }
  .eq > i { display: block; width: 3px; height: 100%; border-radius: 2px; background: var(--accent); transform-origin: bottom; animation: eqbar 1.1s ease-in-out infinite; }
  .eq > i:nth-child(1) { animation-delay: -0.2s; }
  .eq > i:nth-child(2) { animation-delay: -0.5s; background: var(--accent-2); }
  .eq > i:nth-child(3) { animation-delay: -0.1s; }
  .eq > i:nth-child(4) { animation-delay: -0.7s; background: var(--accent-2); }
  @keyframes eqbar { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }

  .live { display: inline-flex; align-items: center; gap: 0.4rem; font-family: var(--font-mono); font-size: 0.64rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
  .live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .console.is-live .live { color: var(--accent); }
  .console.is-live .live .dot { background: var(--accent); animation: livePulse 1.6s ease-out infinite; }
  @keyframes livePulse { 0% { box-shadow: 0 0 0 0 rgba(var(--accent-rgb), 0.55); } 100% { box-shadow: 0 0 0 9px rgba(var(--accent-rgb), 0); } }

  .scope { display: block; width: 100%; height: 178px; border-radius: 0.8rem; background: radial-gradient(120% 80% at 50% 120%, rgba(var(--accent-rgb), 0.08), transparent 70%), #060609; border: 1px solid var(--line); }

  .controls { display: flex; align-items: center; gap: 0.45rem; margin: 0.75rem 0; flex-wrap: wrap; }
  .vbtn { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; padding: 0.45rem 0.7rem; border-radius: 0.55rem; font-family: var(--font-sans); font-size: 0.82rem; font-weight: 500; border: 1px solid var(--line-2); background: var(--surface-2); color: var(--fg); cursor: pointer; transition: all 0.18s ease; min-width: 5.2rem; }
  .vbtn svg { width: 0.95em; height: 0.95em; }
  .vbtn:hover { border-color: rgba(var(--accent-rgb), 0.6); }
  .vbtn--primary { background: linear-gradient(180deg, rgba(var(--accent-rgb), 0.28), rgba(var(--accent-rgb), 0.12)); border-color: rgba(var(--accent-rgb), 0.6); color: #fff; }
  .vbtn--primary[data-state="playing"], .vbtn--primary[data-state="paused"] { background: var(--surface-2); border-color: rgba(var(--accent-rgb), 0.4); color: var(--accent); }
  .vbtn--primary[data-state="loading"] { opacity: 0.7; cursor: progress; }

  .scenes { display: flex; gap: 0.3rem; margin-left: auto; flex-wrap: wrap; }
  .schip { padding: 0.32rem 0.55rem; border-radius: 0.5rem; font-family: var(--font-mono); font-size: 0.7rem; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; transition: all 0.18s ease; }
  .schip:hover { color: var(--fg); border-color: var(--line-2); }
  .schip.is-active { color: #fff; background: rgba(var(--accent-rgb), 0.16); border-color: rgba(var(--accent-rgb), 0.6); }

  .meters { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.6rem; margin: 0.4rem 0 0.8rem; }
  .meter__top { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.68rem; color: var(--muted); margin-bottom: 0.3rem; }
  .meter__val b { font-family: var(--font-mono); font-weight: 500; color: var(--fg); }
  .meter__val em { font-style: normal; color: var(--faint); font-size: 0.62rem; margin-left: 0.15rem; }
  .meter__bar { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
  .meter__bar > i { display: block; height: 100%; width: 0%; border-radius: 3px; transition: width 0.12s linear; }
  .meter--i .meter__bar > i { background: linear-gradient(90deg, var(--accent-2), var(--accent)); }
  .meter--t .meter__bar > i { background: linear-gradient(90deg, #e0a04a, var(--red)); }
  .meter--c .meter__bar > i { background: linear-gradient(90deg, var(--accent), var(--accent-2)); }

  .phaserow { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; padding: 0.5rem 0.65rem; border-radius: 0.6rem; background: rgba(255, 255, 255, 0.025); border: 1px solid var(--line); margin-bottom: 0.8rem; }
  .phase { font-family: var(--font-mono); font-size: 0.68rem; color: var(--faint); transition: color 0.25s ease, text-shadow 0.25s ease; }
  .phase.is-active { color: var(--accent); text-shadow: 0 0 12px rgba(var(--accent-rgb), 0.7); }
  .phase[data-phase="drop"].is-active { color: #fff; text-shadow: 0 0 16px rgba(var(--accent-rgb), 1); }
  .phase__sep { width: 4px; height: 1px; background: var(--line-2); }
  .phase__voices { margin-left: auto; font-family: var(--font-mono); font-size: 0.66rem; color: var(--faint); }
  .phase__voices b { color: var(--muted); }

  .signals__top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.45rem; }
  .signals__label { font-family: var(--font-mono); font-size: 0.62rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
  .pills { display: flex; gap: 0.28rem; flex-wrap: wrap; }
  .spill { font-family: var(--font-mono); font-size: 0.62rem; padding: 0.16rem 0.42rem; border-radius: 999px; background: rgba(255, 255, 255, 0.05); color: var(--faint); transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease; }
  .spill b { font-weight: 600; }
  .spill.hot { transform: translateY(-1px); color: #fff; }
  .spill.transcript.hot { background: var(--blue); }
  .spill.hooks.hot { background: var(--red); }
  .spill.editor.hot { background: var(--green); }
  .spill.composer.hot { background: var(--purple); }

  .rhythm { display: block; width: 100%; height: 56px; border-radius: 0.5rem; background: rgba(255, 255, 255, 0.025); border: 1px solid var(--line); }
  .feed { margin-top: 0.45rem; height: 110px; overflow: hidden; font-family: var(--font-mono); font-size: 0.66rem; line-height: 1.7; -webkit-mask-image: linear-gradient(180deg, #000 62%, transparent); mask-image: linear-gradient(180deg, #000 62%, transparent); }
  .ev { display: flex; gap: 0.55rem; white-space: nowrap; }
  .ev .t { color: var(--faint); opacity: 0.7; }
  .ev .k { font-weight: 500; }
  .ev .s { margin-left: auto; color: var(--faint); }
  .ev.transcript .k { color: #6ab0ff; }
  .ev.hooks .k { color: #ff8478; }
  .ev.editor .k { color: #6fe08f; }
  .ev.composer .k { color: #cda9f5; }

  .diag { margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid var(--line); font-size: 0.64rem; display: grid; gap: 0.25rem; }
  .diag .drow { display: flex; justify-content: space-between; gap: 0.6rem; }
  .diag .drow > span { color: var(--faint); font-family: var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; }
  .diag .drow > b { font-weight: 500; color: var(--muted); text-align: right; font-family: var(--font-mono); }
  .hint { margin-top: 0.7rem; font-size: 0.66rem; color: var(--faint); line-height: 1.5; }

  @media (max-width: 380px) { .meters { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <div class="console" id="vibe" data-scene="${scene}" data-phase="idle">
    <div class="head">
      <span class="brand">
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span>Agent<span class="brand__amp"> Vibes</span></span>
      </span>
      <span class="live"><span class="dot"></span><span id="live-txt">ready</span></span>
    </div>

    <canvas id="scope" class="scope" aria-hidden="true"></canvas>

    <div class="controls">
      <button id="toggle" class="vbtn vbtn--primary" type="button" aria-label="Play" aria-pressed="false">
        <svg class="vbtn__ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
        <span class="label">Play</span>
      </button>
      <div class="scenes" id="scenes" role="group" aria-label="Scene"></div>
    </div>

    <div class="meters">
      <div class="meter meter--i"><div class="meter__top"><span>Intensity</span><span class="meter__val"><b id="i-val">0.00</b></span></div><div class="meter__bar"><i id="i-bar"></i></div></div>
      <div class="meter meter--t"><div class="meter__top"><span>Tension</span><span class="meter__val"><b id="t-val">0.00</b></span></div><div class="meter__bar"><i id="t-bar"></i></div></div>
      <div class="meter meter--c"><div class="meter__top"><span>Tempo</span><span class="meter__val"><b id="c-val">0.00</b><em>cps</em></span></div><div class="meter__bar"><i id="c-bar"></i></div></div>
    </div>

    <div class="phaserow" aria-hidden="true">
      ${phases
        .map(
          (p, idx) =>
            `${idx > 0 ? '<span class="phase__sep"></span>' : ""}<span class="phase" data-phase="${p}">${p}</span>`,
        )
        .join("")}
      <span class="phase__voices">voices <b id="voices">1</b></span>
    </div>

    <div class="signals">
      <div class="signals__top">
        <span class="signals__label">Live signals</span>
        <div class="pills">
          <span class="spill transcript" id="src-transcript">transcript <b class="n">0</b></span>
          <span class="spill hooks" id="src-hooks">hooks <b class="n">0</b></span>
          <span class="spill editor" id="src-editor" title="Typing in code files">files <b class="n">0</b></span>
          <span class="spill composer" id="src-composer" title="Typing in agent chat box">prompt <b class="n">0</b></span>
        </div>
      </div>
      <canvas id="rhythm" class="rhythm" aria-hidden="true"></canvas>
      <div id="feed" class="feed" aria-hidden="true"></div>
    </div>

    <div class="diag">
      <div class="drow"><span>transcript</span><b id="diag-transcript">…</b></div>
      <div class="drow"><span>hooks</span><b id="diag-hooks">…</b></div>
      <div class="drow"><span>composer</span><b id="diag-composer">…</b></div>
    </div>
    <div class="hint">Chat prompt typing &rarr; purple prompt pill. Code-file typing &rarr; green files pill. Hooks fire on Enter and agent actions.</div>
  </div>

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
