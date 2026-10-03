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
