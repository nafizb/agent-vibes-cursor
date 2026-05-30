# Agent Vibes

**Turn your Cursor AI agent's work — and your own typing — into live, generative music.**

While the agent reads files, runs commands, edits code, hits an error, and finally
streams its answer, Agent Vibes builds tension and releases it like a film score.
Pick a scene, hit play, and let the work compose the soundtrack. It's a free,
open-source Cursor / VS Code extension built on [Strudel](https://strudel.cc/),
so every note is synthesized live in the browser — no samples, no streaming, no
accounts, works offline.

> **Status: early V1.** Cinematic is the most developed scene; techno, lo-fi,
> chiptune, piano, and jazz are functional and being tuned. The "react to your
> chat draft" feature is experimental and macOS-oriented (see [Privacy & permissions](#privacy--permissions)).

---

## The idea

Working with an AI agent is oddly passive: you fire a prompt, then watch a wall of
text scroll by. Agent Vibes reframes that wait as a **performance**. The dramatic
arc of an agent run maps onto a piece of music:

```
idle → prompting → thinking → working → (tension on failure) → the drop (response) → resolve
```

The music literally breathes with the work — failures create suspense, and the
final answer is the drop.

## How it works

```
Cursor agent ──┐
               ├─ transcript JSONL (prompt, thoughts, tool calls)
               ├─ hooks (failures, response, stop, subagents)  ──► Conductor ──► Strudel webview
your typing ───┘                                                  (state machine)   (audio)
```

- **Conductor** (`src/conductor.ts`) — a small state machine holding three
  continuous parameters, `intensity`, `tension`, and `cps` (tempo), that ease
  toward per-event targets so the music breathes instead of jerking.
- **Signals**
  - `src/signals/transcript.ts` tails the newest Cursor agent transcript for the
    prompt, the agent's thoughts, and the live stream of tool calls (`Read`,
    `Shell`, `Write`, …). Each tool category colors the music differently.
  - `src/signals/hooksServer.ts` listens on `127.0.0.1:7777` for Cursor hook
    events the transcript can't provide — most importantly `postToolUseFailure`
    (the tension cue), plus `afterAgentResponse` (the drop) and `stop` (resolve).
  - `src/signals/typing.ts` turns typing in open editors into gentle pulses.
  - `src/signals/draftWatcher.ts` *(experimental, macOS)* reacts to the prompt
    you're composing in Cursor's chat box.
- **Scenes** (`src/scenes.ts`) — pure `state → Strudel code` builders. Each scene
  has a fixed identity plus a per-session randomized key/mode so every session
  sounds fresh.
- **Webview** (`webview/main.ts`) — boots `@strudel/web`, receives state, and
  re-evaluates the pattern (throttled) so layers fade in and out smoothly.

## Scenes

| Scene | Vibe |
| --- | --- |
| **Cinematic** | Hans Zimmer-style build to a drop (the showcase scene) |
| **Techno** | Driving 4-on-the-floor build |
| **Lo-fi** | Warm, relaxed beats to code to |
| **Chiptune** | Bright 8-bit arpeggio energy |
| **Piano** | Einaudi-style neoclassical piano |
| **Jazz** | Smoky late-night swing |

Switch scenes live from the panel, or set a default with `agentVibes.scene`.

## Install

### From source (works today)

```bash
git clone https://github.com/nafizb/agent-vibes-cursor.git
cd agent-vibes-cursor
npm install
npm run build      # or: npm run watch
```

Then press **F5** in Cursor / VS Code to launch an Extension Development Host.

### From the marketplace (Open VSX)

Once published, Agent Vibes installs straight from Cursor's extension marketplace
(which is backed by [Open VSX](https://open-vsx.org/)): open the Extensions panel,
search **Agent Vibes**, and click Install. See
[Publishing](#publishing-to-open-vsx) for maintainers.

## Quick start

1. Run **Agent Vibes: Start Jam** from the command palette (the panel also opens
   automatically on startup).
2. Click **▶ Enable audio** (required once by the browser autoplay policy).
3. (Optional) Run **Agent Vibes: Install Cursor Hooks** to wire failure/stop cues,
   then start a **new** agent chat so the hooks take effect.
4. Give the agent a task and listen: ambient drone → bass + kick as it works →
   tension on failures → a lead at the drop when the response streams → resolution.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `agentVibes.scene` | `cinematic` | Active scene (also switchable live in the panel). |
| `agentVibes.hooksPort` | `7777` | Localhost port the extension listens on for hook events. |
| `agentVibes.enableDrumSamples` | `false` | Reserved: load external drum samples (synth percussion is used by default). |
| `agentVibes.experimentalChatDraft` | `true` | **Experimental (macOS):** react to your chat-box draft by polling Cursor's local SQLite store. See below. |

## Privacy & permissions

**TL;DR: Agent Vibes is 100% local.** No accounts, no telemetry, no network
calls — your code and prompts never leave your machine. It's open source, so you
can verify every line. To make the music react to your agent, it reads a few local
Cursor signals; here's exactly what, and how to turn each off.

- **Cursor hooks (how it hears failures/responses).** To get cues the transcript
  doesn't expose, Agent Vibes adds itself to Cursor's hook system: it writes a
  tiny forwarder script to `~/.cursor/agent-vibes-cursor-hooks/send.sh` and merges
  entries into `~/.cursor/hooks.json`. That script does one thing — forward
  Cursor's hook payloads to a listener on your own machine (see below). It's
  installed automatically on first run for a zero-setup experience, and you can
  remove the entries from `hooks.json` anytime to opt out.
- **Local HTTP listener** on `127.0.0.1:7777` (configurable) that receives those
  hook events. It's bound to localhost — nothing is exposed to your network.
- **Transcript reading.** Tails the newest agent transcript under
  `~/.cursor/projects/**/agent-transcripts/` to follow prompts, thoughts, and tool
  calls. Read-only; the music is generated from the *shape* of activity, not your
  content.
- **Experimental chat-draft watcher** (`agentVibes.experimentalChatDraft`, macOS).
  So the music can start mixing while you *type* a prompt, this reads Cursor's
  local `state.vscdb` (read-only) to notice your draft changing. It uses
  undocumented Cursor internals, so it's clearly labeled experimental and may
  break on Cursor updates. Don't want it? Set `agentVibes.experimentalChatDraft`
  to `false` and it's fully disabled. (It also needs the `sqlite3` CLI on your
  `PATH`.)

Everything above stays on `localhost`. Nothing is sent anywhere.

## Limitations

- Tuned for **Cursor** specifically — it relies on Cursor's transcript and hook
  behavior.
- All percussion is synthesized (a feature: offline, no asset loading), so don't
  expect large sample libraries.
- Tool **failures** aren't in the transcript, so failure-driven tension needs the
  hooks installed.
- Pattern aesthetics are early and meant to be tuned — PRs welcome.

## Contributing

Contributions are very welcome — especially new scenes and tuning of existing
ones. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, architecture notes, and
how to add a scene.

## Publishing to Open VSX

Maintainers can publish to the registry Cursor uses for extensions:

```bash
npm run package                 # produces a .vsix via vsce
npx ovsx create-namespace <publisher> -p <token>   # one time
npm run publish:ovsx            # or: npx ovsx publish -p <token>
```

You'll need an [Open VSX](https://open-vsx.org/) account, an access token, and a
namespace matching the `publisher` field in `package.json`. A GitHub Actions
workflow that publishes on tagged releases is included at
`.github/workflows/release.yml`.

## License

[MIT](./LICENSE). Built with [Strudel](https://strudel.cc/) — a JavaScript
live-coding music engine ported from TidalCycles. Thanks to the Strudel and
TidalCycles communities.
