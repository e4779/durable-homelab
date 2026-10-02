# Goal

Build a homelab agent on pi-durable in /home/e4779/projects/durable-homelab.

- M0 ✅: the coding-agent durable example runs outside the monorepo; import map in docs/M0.md.
- M1 ✅: own minimal model-runtime (pi-ai builtinModels + pi auth.json → ZAI_API_KEY); zai coding plan verified.
- M2 ✅: web surface SSE + htmx (no build): attach, mid-run steer, kill -9 survival — all demonstrated.
- M3 ✅: extensions — subagent (from example), memory (kn_search), continuity (section + note tool).
- M4 ✅: systemd user service on hlab, enabled, active, serving on :8642; linger on.

Config: z.ai coding plan only (glm-5.3-flash default). Corporate config — later.

**Verified complete by supervisor 2026-10-03** (actor b5b8cd5b, glm-5.3-flash): all milestones
checked against commits 3d1a5ed → cb59c63; M2 discriminator passed (35 SSE updates during
generation, mid-run steer influenced the answer, kill -9 → restart with session intact).
Corporate-config switch remains as the user-directed follow-up.
