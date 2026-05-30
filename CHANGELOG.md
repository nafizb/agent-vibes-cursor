# Changelog

All notable changes to Agent Vibes are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-05-30

Initial public release (early V1).

### Added

- Real-time generative music that reacts to your Cursor agent run, built on
  [Strudel](https://strudel.cc/) with fully synthesized audio (works offline).
- **Conductor** state machine with smoothly-eased `intensity`, `tension`, and
  `cps` (tempo) parameters.
- Four scenes: **cinematic**, **techno**, **lo-fi**, **chiptune**, switchable live
  from the panel, each with a per-session randomized key/mode.
- Signal sources: agent **transcript** tail, a localhost **hooks** listener
  (failures, response, stop, subagents), editor **typing** pulses, and an
  experimental macOS **chat-draft** watcher.
- Panel UI: scene picker, Intensity / Tension / Tempo meters, phase indicator, VU
  meter, live rhythm visualization, event feed, and diagnostics.
- Commands: **Agent Vibes: Start Jam**, **Stop**, and **Install Cursor Hooks**
  (also auto-installed on first activation).

[Unreleased]: https://github.com/nafizb/agent-vibes-cursor/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/nafizb/agent-vibes-cursor/releases/tag/v0.0.1
