import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentEvent } from "../types";

/**
 * Resolve a usable `sqlite3` binary. The extension host (especially a GUI-launched
 * app) often has a minimal PATH, so we probe common absolute locations before
 * falling back to the bare command.
 */
function resolveSqlite(): string | undefined {
  const candidates = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3", "sqlite3"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { timeout: 2000, stdio: "ignore" });
      return bin;
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * EXPERIMENTAL: reads the Cursor chat composer's *unsent draft* by polling the
 * SQLite state stores. This is the only way to react to typing in the chat box,
 * which no official API exposes.
 *
 * Cursor does NOT expose a reliable "currently focused composer" pointer:
 *  - `lastFocusedComposerIds[0]` in the workspace store is stale (it is not
 *    updated when you focus/type in a composer), and
 *  - the composer you type in may have no `workspaceIdentifier` at all, so a
 *    workspace-scoped lookup misses it entirely.
 *
 * So instead of trusting any pointer, we watch a small set of *candidate*
 * composers (the most-recently-active ones, from `composer.composerHeaders`,
 * plus any focused ids) and detect typing by diffing each candidate's draft
 * text every tick. Whichever draft is actively changing is where you're typing
 * -- regardless of workspace binding.
 *
 * Undocumented and may break on any Cursor update -- hence isolated and
 * fail-safe: any error simply disables the watcher without affecting the rest.
 */
const SEP = "\x1f"; // unit separator between key and (newline-flattened) text
const MAX_CANDIDATES = 14;
const POLL_MS = 250;
const POLL_MS_ACTIVE = 80; // faster while someone is typing in a pinned composer
const REFRESH_MS = 1500;
const TYPING_EMIT_MS = 120;
/** Empty Lexical richText templates are ~142–176 chars; real drafts exceed this. */
const EMPTY_RICHTEXT_MAX = 180;

export class DraftWatcher {
  private timer: NodeJS.Timeout | undefined;
  private idTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private workspaceDb: string | undefined;
  private globalDb: string;
  private available = true;
  private sqlite: string | undefined;
  private candidates: string[] = [];
  private lastEmitId: string | undefined;
  private lastError = "";
  /** Per-composer last seen draft text, so we can diff to find active typing. */
  private lastTexts = new Map<string, string>();
  /** richText blob length — Cursor often updates this before $.text flushes. */
  private lastRichLens = new Map<string, number>();
  /** Until the first successful poll we only establish a baseline (no events). */
  private primed = false;
  /** Composers pinned by sessionStart — always watched even if not in top-N headers. */
  private pinned = new Set<string>();
  /** Poll faster until this timestamp (recent composer typing). */
  private activeUntil = 0;
  private lastTypingEmit = 0;

  constructor(
    workspaceRoot: string,
    globalStorageDir: string,
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {
    // …/User/globalStorage/state.vscdb
    this.globalDb = path.join(globalStorageDir, "state.vscdb");
    this.workspaceDb = findWorkspaceDb(globalStorageDir, workspaceRoot);
  }

  start(): void {
    this.sqlite = resolveSqlite();
    if (!this.sqlite) {
      this.available = false;
      this.lastError = "sqlite3 not found";
      return;
    }
    if (!fs.existsSync(this.globalDb)) {
      this.available = false;
      this.lastError = "state.vscdb not found";
      return;
    }
    this.refreshCandidates();
    this.idTimer = setInterval(() => this.refreshCandidates(), REFRESH_MS);
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.disposed) return;
    const ms = Date.now() < this.activeUntil ? POLL_MS_ACTIVE : POLL_MS;
    this.timer = setTimeout(() => {
      this.pollDrafts();
      this.schedulePoll();
    }, ms);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.idTimer) clearInterval(this.idTimer);
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * sessionStart fires as soon as a new agent tab opens, before the composer
   * appears in composerHeaders with a lastUpdatedAt. Pin it immediately so we
   * don't miss the first prompt typed into a clean tab.
   */
  pinComposer(id: string): void {
    if (!isComposerId(id)) return;
    this.pinned.add(id);
    this.activeUntil = Date.now() + 30_000;
    if (!this.candidates.includes(id)) {
      this.candidates = [id, ...this.candidates].slice(0, MAX_CANDIDATES + this.pinned.size);
    }
    this.refreshCandidates();
    this.pollDrafts();
  }

  /** Human-readable status for the panel diagnostics footer. */
  status(): string {
    if (!this.available) return `off — ${this.lastError}`;
    const pin = this.pinned.size ? ` · pinned ${this.pinned.size}` : "";
    const where = this.lastEmitId ? ` · typing→${this.lastEmitId.slice(0, 8)}` : "";
    return `ok · ${this.candidates.length} composers${pin}${where}`;
  }

  /**
   * Rebuild the candidate composer set: the most-recently-updated composers
   * (across all windows) plus any focused ids. `lastUpdatedAt` does not bump on
   * draft typing, but the conversation you're typing into was generally touched
   * recently, so the top-N reliably contains it.
   */
  private refreshCandidates(): void {
    const set = new Set<string>(this.pinned);
    let pending = this.workspaceDb ? 3 : 2;

    const finalize = () => {
      pending--;
      if (pending > 0) return;
      // Keep watching any composer that currently holds a non-empty draft, so an
      // in-progress draft is never dropped mid-typing. Drop empty/stale ones to
      // keep the watch list (and the IN clause) bounded.
      let kept = 0;
      for (const [id, text] of this.lastTexts) {
        if (text.length > 0) {
          set.add(id);
          kept++;
        } else {
          this.lastTexts.delete(id);
        }
      }
      const cap = MAX_CANDIDATES + this.pinned.size + kept;
      this.candidates = Array.from(set).slice(0, cap);
    };

    if (this.workspaceDb) {
      query(
        this.sqlite!,
        this.workspaceDb,
        "SELECT json_extract(value,'$.lastFocusedComposerIds') FROM ItemTable WHERE key='composer.composerData';",
        (out) => {
          for (const id of parseIdArray(out)) set.add(id);
          finalize();
        },
        finalize,
      );
    }

    query(
      this.sqlite!,
      this.globalDb,
      "SELECT c.value->>'composerId' FROM ItemTable t, json_each(json_extract(t.value,'$.allComposers')) c " +
        "WHERE t.key='composer.composerHeaders' " +
        "ORDER BY (c.value->>'lastUpdatedAt') DESC LIMIT " +
        MAX_CANDIDATES +
        ";",
      (out) => {
        for (const id of out.split("\n")) {
          const t = id.trim();
          if (isComposerId(t)) set.add(t);
        }
        finalize();
      },
      finalize,
    );

    // Brand-new agent tabs often have no lastUpdatedAt and never rank in the
    // top-N header list, but their draft text is already in cursorDiskKV.
    query(
      this.sqlite!,
      this.globalDb,
      "SELECT replace(key,'composerData:','') FROM cursorDiskKV " +
        "WHERE key LIKE 'composerData:%' AND (" +
        "length(coalesce(json_extract(value,'$.text'),'')) > 0 OR " +
        "length(coalesce(json_extract(value,'$.richText'),'')) > " +
        EMPTY_RICHTEXT_MAX +
        ") ORDER BY rowid DESC LIMIT 12;",
      (out) => {
        for (const id of out.split("\n")) {
          const t = id.trim();
          if (isComposerId(t)) set.add(t);
        }
        finalize();
      },
      finalize,
    );
  }

  private pollDrafts(): void {
    if (this.disposed || this.candidates.length === 0) return;
    const keys = this.candidates
      .filter(isComposerId)
      .map((id) => `'composerData:${id}'`)
      .join(",");
    if (!keys) return;

    // One batched, newline-safe read of every candidate's draft text + richText.
    const sql =
      "SELECT key || char(31) || " +
      "replace(replace(coalesce(json_extract(value,'$.text'),''),char(10),' '),char(13),' ') || char(31) || " +
      "coalesce(json_extract(value,'$.richText'),'') " +
      `FROM cursorDiskKV WHERE key IN (${keys});`;
    query(
      this.sqlite!,
      this.globalDb,
      sql,
      (out) => this.handleBatch(out),
      () => {
        this.lastError = "query failed (db locked?)";
      },
    );
  }

  private handleBatch(out: string): void {
    if (this.disposed) return;

    let best: { id: string; text: string; delta: number } | undefined;

    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split(SEP);
      if (parts.length < 2) continue;
      const key = parts[0];
      const plain = parts[1] ?? "";
      const richText = parts.slice(2).join(SEP);
      const fromRich = richText ? extractLexicalText(richText) : "";
      const text = pickDraftText(plain, fromRich);
      const richLen = richText.length;
      const id = key.startsWith("composerData:") ? key.slice("composerData:".length) : key;

      const prev = this.lastTexts.get(id);
      const prevRich = this.lastRichLens.get(id) ?? 0;
      this.lastTexts.set(id, text);
      this.lastRichLens.set(id, richLen);

      if (!this.primed) continue;
      if (prev === undefined) {
        if (text.length > 0) {
          const delta = text.length;
          if (!best || delta > best.delta) best = { id, text, delta };
        }
        continue;
      }
      const changed = text !== prev || richLen !== prevRich;
      if (!changed) continue;
      if (text.length === 0 && richLen <= EMPTY_RICHTEXT_MAX) continue;

      const delta = Math.max(Math.abs(text.length - prev.length), Math.abs(richLen - prevRich));
      if (!best || delta > best.delta) best = { id, text, delta };
    }

    if (!this.primed) {
      this.primed = true;
      return;
    }

    if (best) {
      const now = Date.now();
      this.activeUntil = now + 15_000;
      this.lastEmitId = best.id;
      this.onEvent({ kind: "draft", source: "composer", ts: now, text: best.text });
      // Rhythm pulses while prompting — mirrors editor typing, but source stays composer.
      if (now - this.lastTypingEmit >= TYPING_EMIT_MS) {
        this.lastTypingEmit = now;
        this.onEvent({ kind: "typing", source: "composer", ts: now });
      }
    }
  }
}

function isComposerId(s: string): boolean {
  return /^[0-9a-fA-F-]{8,}$/.test(s);
}

/** Cursor may lag on $.text; prefer whichever source has more content. */
function pickDraftText(plain: string, fromRich: string): string {
  if (fromRich.length > plain.length) return fromRich;
  if (plain.length > fromRich.length) return plain;
  return plain || fromRich;
}

/** Pull plain text out of Cursor's Lexical richText JSON when $.text is empty. */
function extractLexicalText(richTextJson: string): string {
  try {
    const parts: string[] = [];
    walkLexical(JSON.parse(richTextJson), parts);
    return parts.join("");
  } catch {
    return "";
  }
}

function walkLexical(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "text" && typeof n.text === "string") out.push(n.text);
  const children = n.children;
  if (Array.isArray(children)) {
    for (const child of children) walkLexical(child, out);
  }
  if (n.root) walkLexical(n.root, out);
}

function parseIdArray(out: string): string[] {
  try {
    const arr = JSON.parse(out.trim());
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function findWorkspaceDb(globalStorageDir: string, workspaceRoot: string): string | undefined {
  // …/User/globalStorage -> …/User/workspaceStorage
  const userDir = path.dirname(globalStorageDir);
  const wsRoot = path.join(userDir, "workspaceStorage");
  let entries: string[];
  try {
    entries = fs.readdirSync(wsRoot);
  } catch {
    return undefined;
  }
  const target = `file://${workspaceRoot}`;
  for (const ent of entries) {
    const metaPath = path.join(wsRoot, ent, "workspace.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const folder: string | undefined = meta?.folder;
      if (folder && (folder === target || folder.endsWith(encodeURI(workspaceRoot)))) {
        const db = path.join(wsRoot, ent, "state.vscdb");
        if (fs.existsSync(db)) return db;
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

function query(
  bin: string,
  db: string,
  sql: string,
  onResult: (out: string) => void,
  onError?: () => void,
): void {
  execFile(bin, ["-readonly", db, sql], { timeout: 1500, maxBuffer: 1 << 20 }, (err, stdout) => {
    if (err) {
      onError?.(); // sqlite3 missing or locked -- ignore this tick
      return;
    }
    onResult(stdout);
  });
}
