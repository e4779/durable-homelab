# durable-homelab

Personal homelab agent built on pi-durable (experimental substrate by Earendil).
Web surface: server-rendered HTML fragments (SSE + htmx, zero build) over a durable
harness. Runs as a systemd user service on hlab.

## Run

- Dev: `node src/serve.ts` → http://127.0.0.1:8642
- Service: `systemctl --user start durable-homelab`

## Layout

- `src/runtime.ts` — harness assembly (opens SQLite storage, ModelRuntime = pi-ai
  builtinModels over pi auth.json, registry, view/controller seam)
- `src/extensions/` — memory (kn_search), continuity (section + note tool), subagent
- `src/web.ts` — SSE + htmx surface; `src/serve.ts` — entry
- `goal.md` — the standing goal and milestone ledger

## Conventions

- Zero build: node 24 type stripping, vendored htmx. Keep it that way.
- Config: z.ai coding plan (glm-5.3-flash default); credentials read from
  ~/.pi/agent/auth.json (bridged into ZAI_API_KEY), never committed.
- policy/methodology live in skills and this file, not in machinery.

## Reference docs (read before non-trivial work)

- `docs/pi-durable-examples/` — 29 canonical pi-durable patterns (copied from upstream,
  commit pinned in its README). Index table inside maps tasks → example files.
  Read before inventing durable APIs: per-conversation docs, watches, forks,
  subagents, compaction are all covered there.
- `docs/htmx-web-components.md` — verdict + gotchas on mixing web components with htmx
  (light DOM only, `htmx.process` rules). Read before adding reusable UI widgets.

## Hard-won rules (incidents 2026-10-03/04 — read before editing src/)

1. After ANY edit to src/*.ts: `node scripts/smoke.ts`, then `bash scripts/check-and-restart.sh`
   (never raw `systemctl restart`). Smoke renders fragments on mock data; broken files refuse to start.
2. The PAGE constant in `src/web.ts` is a template literal: every backslash in client JS
   must be doubled in source (`\d` → `\\d`, `\/` → `\\/`). Cooked escapes there have
   crash-looped the service three times. `node --check` the extracted <script> if unsure.
3. Parallel agents editing this repo have corrupted files mid-session more than once:
   re-read current file content before patching; never trust remembered text.
4. The web server holds ONE current conversation globally. Two tabs fight over it
   (last switch wins) — known Projects v2 limitation.

## Service restart guard (incident 2026-10-03)

Editing src/*.ts while the service runs: a syntax error crash-loops durable-homelab
(Restart=on-failure retries a broken file). ALWAYS import-check changed files before restart:

	node --input-type=module -e 'await import("./src/web.ts"); await import("./src/runtime.ts"); console.log("ok")'

Client code inside the PAGE template literal: escape dollar-brace as backslash-dollar-brace,
or prefer string concatenation. The agent editing its own UI is allowed (and encouraged) —
with the check above first.
