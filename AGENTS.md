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
