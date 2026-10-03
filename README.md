# durable-homelab

A zero-build web surface for a personal agent built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) — Earendil's experimental durable agent harness.

**Status: experimental.** Built in a day on a substrate that shipped the day before. The pi-durable API is still settling — this repo pins `^1.0.0` and will track it.

## What it is

One process, two jobs:

1. **A durable agent** — sessions, transcripts, tools (read/edit/bash via pi-durable's CodingTools), subagents, kn-backed memory search, a continuity log. Everything is a durable task: it survives crashes, counts its own cost, and can be steered mid-run.
2. **A web surface for it** — server-rendered HTML fragments over SSE, wired with [htmx](https://htmx.org). No bundler, no client framework, no build step. Sessions sidebar, live streaming, mid-run steering, late join.

```
chord (state + transport machinery)
  ↑
pi-durable (agent semantics: sessions, tasks, compaction)
  ↑
this repo (agent config + web surface)      ← you are here
```

## Why it looks like this

- **Zero build**: plain TypeScript run by node 24 type stripping, one vendored JS file (htmx). The tool stays inspectable — and the agent itself can maintain its own UI.
- **Server-rendered fragments**: all durable state lives server-side; the browser is a renderer. The hardest problem of agent web UIs (client state sync) disappears by construction.
- **Durable-native sessions**: conversations are first-class (create, switch, fork-able), subagents are just conversations, everything survives `kill -9`.

## Quickstart

Requirements: Node >= 24, and a provider credential in pi's auth store (this defaults to the [z.ai coding plan](https://z.ai); any pi provider works with a small config change).

```bash
git clone https://github.com/e4779/durable-homelab.git
cd durable-homelab
npm install
node src/serve.ts
# → http://127.0.0.1:8642
```

Credentials are read read-only from `~/.pi/agent/auth.json` (pi's own store; bridge logic in `src/credentials.ts`). Set `PI_AGENT_DIR` to point elsewhere, `PORT` for the port, `KN_DIR` for the knowledge base the memory tool searches.

## Run as a service

A systemd user unit template lives in [`deploy/`](deploy/durable-homelab.service) — adjust paths, then:

```bash
cp deploy/durable-homelab.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now durable-homelab
```

## Layout

- `src/runtime.ts` — harness assembly; the `DurableView` / `DurableController` seam that surfaces plug into
- `src/web.ts` — SSE + htmx surface (fragment renderers + routes)
- `src/extensions/` — memory (kn search), continuity (persistent notes), subagent
- `src/model-runtime.ts` — pi-ai `builtinModels` over pi's auth store
- `docs/M0.md` — what porting off the monorepo actually required
- `goal.md` — the milestone ledger; `continuity.md` — the agent's own handoff log

## Built in the open

This project is developed agent-first: an agent (running on this very stack) wrote most of the code, and its working memory lives in the repo — see `goal.md` and `continuity.md`. Humans review, steer, and use the thing.

Credits: [Earendil](https://earendil.com) for pi, pi-durable and chord; [jmfederico](https://github.com/jmfederico)'s pi-web for inspiration; [monotykamary](https://github.com/monotykamary)'s pi-fabric ecosystem for the maps.

## License

[MIT](LICENSE)
