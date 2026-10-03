# Handoff (из pi-сессии, 2026-10-03)

Ты — продолжение работы, которая велась в pi coding agent (сессия-архив, знание — в kn).
Этот файл — твой handoff. Прочитай перед работой.

## Контекст проекта

Ты сам себе продукт: агент на pi-durable, собранный в этом репо (M0–M4 закрыты,
верифицированы supervisor'ом — см. goal.md, docs/M0.md). Веб-сёрфейс — SSE + htmx
(ноль сборок) на http://hlab:8642, systemd user service `durable-homelab.service`.

## Ключевые решения (не пересматривать без причины)

- Слои: chord (механика состояния/транспорта) → pi-durable (семантика агента) → этот проект.
  Не строить параллельный рантайм; всё агентское брать из durable.
- Конфиг: z.ai coding plan, glm-5.3-flash дефолт; креды из ~/.pi/agent/auth.json → ZAI_API_KEY
  (read-only bridge в src/credentials.ts). Корпоративный конфиг — отложен пользователем.
- UI: server-rendered HTML фрагменты + htmx + SSE. Никаких бандлеров. Форма ресетится
  через hx-on::after-request; поллинг /fragment каждые 4s — страховка мёртвого SSE.
- pi-fabric НЕ используется (пользователь от него отказался; политика живёт в скиллах и
  AGENTS.md, механика — в durable).

## Открытые задачи (кандидаты, не назначены)

- UI-полировка: сохранение скролла при ре-рендере, серверная подсветка markdown,
  мобильная вёрстка, индикатор живости SSE.
- Projects v2: несколько директорий (per-conversation cwd через configure(tx, id, {agent:{cwd}})).
- MCP для durable-агента: сейчас его нет — CodingTools только. Опции: свой тул-мост или
  ждать нативной интеграции.
- Корпоративный инференс: добавить провайдера в src/model-runtime.ts конфиг.
- Нотка в monotykamary/pi-fabric#169, когда pi CLI начнёт работать на packages/durable
  (watch-лист там же; сейчас — НЕ время, API ещё плывёт).

## Где знание

- ~/kn/bundles/agents/ — pi-1-0-and-durable-launch.md, pico5-next-gen-harness.md,
  chord-composition-runtime.md, pi-099-release-transition-checklist.md (ищется тулом kn_search).
- docs/M0.md — карта порта; goal.md — цели и вердикт верификации.
- [2026-10-03T06:29] Image attachments added to web UI: form 📎 attach + base64 blocks → POST /submit JSON {text, blocks} → controller.submit(text, "steer", blocks?) → durable UserInput (string | (Text|Image)[]). Images render inline in transcript via entryHtml. INCIDENT: concurrent editing session (user's other agent) raced on src/web.ts+runtime.ts → crash loop (89 restarts, nested backticks inside PAGE template literal break node type-stripping — never use nested ` or ${} in the PAGE client script), git reverts, and a 0-byte web.ts. Rebuilt web.ts from context; agreed with user: single-threaded edits through this session. Verify image send works with glm-5.3-flash (vision support unconfirmed).

- [2026-10-03] Incident: my own edit to src/web.ts (image attachments) crashed the service in a restart loop — nested backticks inside the PAGE template literal, server not updated to the JSON protocol. Fixed: feature completed client+server, /submit dual-mode (JSON blocks + legacy form), controller.submit passes content blocks to durable. Rule learned: import-check src files before every service restart.
