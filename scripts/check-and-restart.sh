#!/usr/bin/env bash
# Import-check every src file, then restart durable-homelab.
# The durable agent MUST use this instead of raw systemctl restart
# (a syntax error in src/ crash-loops the service — incidents 2026-10-03/04).
set -e
cd "$(dirname "$0")/.."
node --input-type=module -e "for (const f of ['web.ts', 'runtime.ts', 'serve.ts']) await import('./src/' + f); console.log('imports ok')"
systemctl --user restart durable-homelab.service
systemctl --user is-active durable-homelab.service
