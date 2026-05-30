# Contributing to Agent Vibes

Thanks for your interest in hacking on Agent Vibes! It's an early V1, so there's
lots of room to improve — especially the music. Issues and PRs are very welcome.

## Development setup

```bash
git clone https://github.com/nafizb/agent-vibes-cursor.git
cd agent-vibes-cursor
npm install
npm run watch      # rebuilds on change (or `npm run build` for a one-off)
```

Press **F5** in Cursor / VS Code to launch an Extension Development Host with the
extension loaded. In that window:

1. Run **Agent Vibes: Start Jam**.
2. Click **▶ Enable audio**.
3. Optionally run **Agent Vibes: Install Cursor Hooks**, then start a new agent
   chat to exercise failure/stop cues.

Before opening a PR:

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm run build       # must succeed
```

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, the webview panel, hook installation, wiring signals → conductor. |
| `src/conductor.ts` | The state machine: turns events into smoothly-eased `intensity` / `tension` / `cps`. No VS Code or audio deps (easy to test). |
| `src/scenes.ts` | Pure `MusicalState → Strudel program string` builders, one per scene. |
| `src/types.ts` | Shared types: `AgentEvent`, `MusicalState`, tool categories. |
| `src/signals/*` | Event sources: `transcript`, `hooksServer`, `typing`, `draftWatcher`. |
| `webview/main.ts` | Boots `@strudel/web`, renders the panel UI, re-evaluates patterns. |
| `hooks/` | Reference copy of the hook forwarder the extension installs. |

Data flow: a **signal** emits an `AgentEvent` → `dispatch()` feeds the
**Conductor** and mirrors it to the panel → the Conductor eases its parameters and
emits `MusicalState` → the **webview** rebuilds the Strudel pattern.

## Adding a scene

1. Add the scene id to `SceneId` in `src/types.ts`.
2. Add a builder function in `src/scenes.ts` and route to it in `buildPattern()`.
   A builder receives `MusicalState` and returns a Strudel program string. Use the
   `ramp()` helper to fade layers in by `intensity`, react to `tension` with
   dissonance / filtering, and let `cps` drive tempo. End with the shared `wrap()`.
3. Register it in `SCENES` (label + blurb) so it shows in the panel.
4. Add its key/mode palette to `MODES_BY_SCENE` and a `CPS_RANGE` in
   `src/conductor.ts`.
5. Add it to the `agentVibes.scene` enum in `package.json`.

Keep percussion synthesized (no external samples) so the extension stays offline.

## Conventions

- TypeScript, `strict` mode. Keep `npm run typecheck` clean.
- Comments explain **why**, not what. Avoid narrating the code.
- The `draftWatcher` reads undocumented Cursor internals — keep it isolated and
  fail-safe: any error should disable just that watcher, never crash the rest.
- Don't add network calls. The extension is local-only by design; preserve that.

## Reporting bugs

Open an issue with your OS, Cursor version, the active scene, and what you
expected vs. heard. Diagnostics from the panel footer (transcript / hooks /
composer status) are very helpful.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
