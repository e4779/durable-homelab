# pi-durable canonical examples

Copied from https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples
(source commit 83692682f095528f8b71652ddacff7075e36e893, 2026-10-04).
Run them from a pi-durable checkout: `node --conditions=source --experimental-strip-types test/examples/<name>.ts`.

## When to read what

| Task | Read first |
|---|---|
| Conversations, submit, steer, followUp | `00-conversation.ts` |
| Per-conversation docs (`defineDoc`, scope conversation) | `01-documents.ts`, **`29-sandbox-per-conversation.ts`** |
| Reading another conversation's doc | `07-configuration.ts` (`harness.snapshot(AgentDoc, id, ctx)`) |
| Creating conversations with options (`agent: { cwd, model }`, `init`) | `08-harness-conversations.ts`, `29-*` |
| Forks, ownership, owned conversations | `02-forks.ts`, `03-owned-conversations.ts` |
| Watches (reactive state for UIs) | `05-watches.ts` |
| Harness assembly, env, registry | `06-harness.ts`, `17-coding-tools.ts`, `26-coding-agent.ts` |
| Context view / what the model sees | `09-context.ts` |
| Extensions with state, registry reload | `10-registry-reload.ts`, `11-extension-state.ts` |
| Tasks, background tasks, child tasks | `12-tasks.ts`, `24-child-tasks.ts` |
| Recovery after crash | `13-recovery.ts` |
| Compaction | `25-compaction.ts` |
| Subagents (foreground/background) | `22-*`, `23-*` |
| Inbox (late inputs) | `20-inbox.ts` |

## Patterns this repo already uses (do not reinvent)

- Per-conversation cwd (Projects v2): `configure(tx, id, { agent: { cwd } })` at creation;
  read back via `opened.snapshot(AgentDoc, rec.id, context)` — see `src/runtime.ts`.
- Extension tools: `defineTool` + `defineExtension` — see `src/extensions/*.ts`.
- MCP over mcporter-as-a-library: `src/extensions/mcp.ts` (mirror of pi-fabric's approach).
