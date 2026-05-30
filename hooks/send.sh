#!/usr/bin/env bash
# Reference copy of the hook forwarder. The extension's "Install Cursor Hooks"
# command writes a port-baked version of this to ~/.cursor/agent-vibes-cursor-hooks/send.sh
# and registers it in ~/.cursor/hooks.json.
PORT="${AGENT_VIBES_PORT:-7777}"
payload="$(cat)"
curl -s -m 1 -X POST "http://127.0.0.1:${PORT}/event" \
  -H 'Content-Type: application/json' \
  -d "$payload" >/dev/null 2>&1 || true
