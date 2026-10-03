import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DurableController, DurableView } from "./runtime.ts";

const esc = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const entryText = (entry: any): string => {
	const message = entry?.model?.[0];
	if (message === undefined) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return (content ?? [])
		.flatMap((block: any) =>
			block.type === "text"
				? [block.text]
				: block.type === "image"
					? ["[image attached]"]
					: block.type === "tool_call"
						? [`[tool: ${block.name}]`]
						: [],
		)
		.join("\n");
};

const escAttr = (s: string): string => esc(s).replace(/'/g, "&#39;");

/** Escape-first mini-markdown: fences, headings, bullets, `code`, **bold**, *em*, links. */
export function renderMarkdown(src: string): string {
	const parts = src.split("```");
	return parts
		.map((chunk, i) => {
			if (i % 2 === 1) {
				const nl = chunk.indexOf("\n");
				const body = nl >= 0 ? chunk.slice(nl + 1) : chunk;
				return '<pre class="code">' + esc(body.replace(/\n$/, "")) + "</pre>";
			}
			return chunk
				.split("\n")
				.map((line) => {
					const e = esc(line);
					let h: string;
					if (/^#{1,4}\s/.test(e)) h = '<div class="md-h">' + e.replace(/^#{1,4}\s+/, "") + "</div>";
					else if (/^\s*[-*]\s+/.test(e)) h = e.replace(/^(\s*)[-*]\s+/, "$1• ");
					else h = e;
					return h
						.replace(/`([^`]+)`/g, "<code>$1</code>")
						.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
						.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
						.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
				})
				.join("\n");
		})
		.join("");
}

const IMG_MIME: Record<string, string> = {
	"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};
const IMG_CACHE_DIR = join(process.cwd(), ".imgcache");

/** Stable URL for an image block: served from a disk cache with immutable caching. */
function imageUrl(data: string, mimeType: string): string {
	const ext = IMG_MIME[mimeType] ?? "png";
	const hash = createHash("sha256").update(data).digest("hex").slice(0, 20);
	const file = join(IMG_CACHE_DIR, `${hash}.${ext}`);
	if (!existsSync(file)) {
		try {
			mkdirSync(IMG_CACHE_DIR, { recursive: true });
			writeFileSync(file, Buffer.from(data, "base64"));
		} catch { /* cache write failures are non-fatal */ }
	}
	return `/img/${hash}.${ext}`;
}

/** HTML for one entry's content blocks; images render inline, safely sized. */
const entryHtml = (entry: any): string => {
	const message = entry?.model?.[0];
	if (message === undefined) return "";
	const content = message.content;
	if (typeof content === "string") return esc(content);
	return (content ?? [])
		.map((block: any) =>
			block.type === "text"
				? renderMarkdown(String(block.text ?? ""))
				: block.type === "image"
					? '<img class="shot" src="' + imageUrl(block.data, block.mimeType) + '" alt="attached image" loading="lazy" />'
					: block.type === "tool_call"
						? esc(`[tool: ${block.name}]`)
						: "",
		)
		.filter((s: string) => s.length > 0)
		.join("\n");
};

const MAX_RENDERED_ENTRIES = 60;

function transcript(view: DurableView): string {
	const entries: any[] = view.conversation.entries ?? [];
	const windowed = entries.slice(-MAX_RENDERED_ENTRIES);
	const parts: string[] = [];
	for (const entry of windowed) {
		const text = entryText(entry).trim();
		if (text.length === 0) continue;
		if (entry.kind === "pi.user") {
			parts.push(`<div class="msg user"><span class="who">you</span><div class="body">${entryHtml(entry)}</div></div>`);
		} else if (entry.kind === "pi.assistant" || entry.kind === "pi.message") {
			parts.push(`<div class="msg assistant"><span class="who">agent</span><div class="body">${entryHtml(entry)}</div></div>`);
		} else if (entry.kind === "pi.tool-result") {
			const first = text.split("\n")[0] || "tool result";
			parts.push(
				`<details class="msg event toolres"><summary>🔧 ${esc(first.slice(0, 120))}</summary>` +
				`<pre>${esc(text)}</pre></details>`,
			);
		} else {
			parts.push(`<div class="msg event"><span class="who">${esc(entry.kind)}</span><pre>${esc(text.slice(0, 400))}</pre></div>`);
		}
	}
	if (windowed.length < entries.length) parts.unshift(`<div class="msg event">… ${entries.length - windowed.length} older entries in storage …</div>`);
	return parts.join("\n");
}

const activeId = (view: DurableView): number => view.conversation.conversation?.id ?? -1;

export function renderMain(view: DurableView): string {
	const notices = view.notices
		.slice(-5)
		.map((n) => `<div class="notice ${n.level}">${esc(n.message)}</div>`)
		.join("\n");
	return `
<div id="notices">${notices}</div>
<div id="transcript">${transcript(view)}</div>`;
}

export function renderSidebar(view: DurableView): string {
	const active = activeId(view);
	const defaultCwd = view.session.cwd;
	const projects = view.projects ?? [defaultCwd];
	const projectName = (cwd: string): string => cwd.replace(/\/+$/, "").split("/").pop() || cwd;
	const recency = (c: { lastEntryId?: string }): number => {
		const n = Number(c.lastEntryId);
		return Number.isFinite(n) && c.lastEntryId !== undefined ? n : 0;
	};
	const renderConvo = (c: (typeof view.conversations)[number]): string =>
		`<a class="convo${c.id === active ? " active" : ""}${c.cwd === defaultCwd && c.label === "main" ? " convo-root" : " convo-sub"}" href="/${c.id}" hx-trigger="click" hx-post="/switch" hx-vals='{"id":${c.id}}' hx-swap="none">` +
		`<span class="label">${esc(c.label)}</span>${c.title ? `<span class="title">${esc(c.title.slice(0, 60))}</span>` : ""}</a>`;

	const groups: string[] = [];
	for (const project of projects) {
		const convos = view.conversations
			.filter((c) => (c.cwd ?? defaultCwd) === project)
			.sort((a, b) => recency(b) - recency(a));
		if (convos.length === 0 && project !== defaultCwd) continue;
		groups.push(
			`<div class="project-head">▾ <span title="${escAttr(project)}">${esc(projectName(project))}</span>` +
			`<button class="proj-new" title="new session in ${escAttr(projectName(project))}" hx-post="/new" hx-vals='${JSON.stringify({ cwd: project }).replace(/'/g, "&#39;")}' hx-swap="none">+</button></div>` +
			`<div class="proj-group">${convos.map(renderConvo).join("\n") || '<div class="empty">no sessions</div>'}</div>`,
		);
	}
	return `
<button class="add-project" hx-post="/projects/add" hx-prompt="Absolute path of the project directory" hx-swap="none">+ add project</button>
${groups.join("\n")}`;
}

const fmtTokens = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

const fmtCost = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);

/** Session-wide token/cost footer from the `pi.usage` ledger. */
function usageFooter(view: DurableView): string {
	const usage = view.conversation.docs?.["pi.usage"] as any;
	if (!usage) return "";
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	const addBucket = (bucket: any): void => {
		for (const u of Object.values(bucket ?? {})) {
			const u2 = u as any;
			sum.input += Number(u2?.input ?? 0);
			sum.output += Number(u2?.output ?? 0);
			sum.cacheRead += Number(u2?.cacheRead ?? 0);
			sum.cacheWrite += Number(u2?.cacheWrite ?? 0);
			sum.total += Number(u2?.totalTokens ?? 0);
			const c = u2?.cost ?? {};
			sum.cost += Number(c?.total ?? (Number(c?.input ?? 0) + Number(c?.output ?? 0) + Number(c?.cacheRead ?? 0) + Number(c?.cacheWrite ?? 0)));
		}
	};
	addBucket(usage.models);
	addBucket(usage.tools);
	if (sum.total === 0) return "";
	return `<span class="usage" title="session totals: input/output/cache-read tokens, approximate cost">` +
		`${fmtTokens(sum.input)} in · ${fmtTokens(sum.output)} out · ${fmtTokens(sum.cacheRead)} cache · ~${fmtCost(sum.cost)}</span>`;
}

/** Rough context-window gauge: active-context estimate vs the model window. */
function contextGauge(view: DurableView): string {
	const ref = view.conversation.docs?.["pi.agent"]?.model as any;
	const model = (view.models ?? []).find((m) => m.provider === ref?.provider && (m.modelId === ref?.modelId || m.id === ref?.modelId));
	const window = Number(model?.contextWindow ?? 0);
	if (!window) return "";
	let chars = 0;
	for (const entry of view.conversation.entries ?? []) {
		for (const msg of (entry as any).model ?? []) {
			for (const block of msg.content ?? []) {
				if (block.type === "text") chars += String(block.text ?? "").length;
				else if (block.type === "image") chars += 1200; // vision tokens are roughly fixed-size after downscale
				else if (block.type === "toolCall" || block.type === "tool_result") chars += JSON.stringify(block ?? {}).length;
			}
		}
	}
	const tokens = Math.round(chars / 4);
	const pct = Math.min(100, (tokens / window) * 100);
	const cls = pct > 85 ? "ctx-hot" : pct > 60 ? "ctx-warm" : "";
	return `<span class="ctx ${cls}" title="context: ~${fmtTokens(tokens)} of ${fmtTokens(window)} tokens (${fmtTokens(window - tokens)} free)">` +
		`<span class="ctxbar"><i style="width:${pct.toFixed(1)}%"></i></span>${pct.toFixed(1)}% · ${fmtTokens(tokens)}/${fmtTokens(window)}</span>`;
}

export function renderHeader(view: DurableView): string {
	const model = view.conversation.docs?.["pi.agent"]?.model;
	const id = activeId(view);
	const busy = (view.conversation.docs?.["pi.live"] as any)?.run !== undefined;
	const live = busy
		? '<span class="pulse" title="a run is in flight">● generating</span>'
		: '<span class="idle-dot" title="idle">○</span>';
	return `<span data-convo-id="${id}" class="hdr">${live}<span class="model">${esc(model ? `${model.provider}/${model.modelId}` : "no model")}</span><span class="session" title="${esc(view.session.id)}">${esc(view.session.id.slice(0, 12))}…</span></span>`;
}

/** Thin status strip at the very bottom: session spend + context-window gauge. */
export function renderFooter(view: DurableView): string {
	return `<div class="footer-strip">${usageFooter(view)}${contextGauge(view)}</div>`;
}

const PAGE = `
<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>durable-homelab</title>
	<script src="/vendor/htmx.min.js"></script>
	<style>
		:root {
			color-scheme: dark;
			--bg: #0c0f14; --panel: #12161d; --panel-2: #171c25; --line: #232a35;
			--text: #d6dde6; --dim: #7d8894; --faint: #55606c;
			--accent: #4a8fd4; --user-bg: #16202e; --agent-bg: #141b16; --event-bg: #12141a;
		}
		* { box-sizing: border-box; }
		html, body { height: 100%; }
		body { font-family: ui-monospace, "JetBrains Mono", "Fira Code", monospace; background: var(--bg); color: var(--text); margin: 0; font-size: 14px; line-height: 1.55; }
		.layout { display: grid; grid-template-columns: var(--sbw, 250px) 4px minmax(0, 1fr); height: 100vh; }
		#divider { cursor: col-resize; background: transparent; }
		#divider:hover, #divider.drag { background: #2a3a52; }
		aside { border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
		#sidebar-swap, aside .convo { min-width: 0; max-width: 100%; }
		aside .convo .label { word-break: break-word; }
		.project-head { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--faint); padding: 0.5rem 0.6rem 0.2rem; }
		a.convo-sub { margin-left: 0.9rem; }
		a.convo-root { border: 1px solid var(--line); }
		a.convo-root.active { border-color: #35507a; }
		.ctx { display: inline-flex; align-items: center; gap: 0.4rem; }
		.ctxbar { display: inline-block; width: 56px; height: 5px; border-radius: 3px; background: #232a35; overflow: hidden; }
		.ctxbar i { display: block; height: 100%; background: #4a8fd4; border-radius: 3px; }
		.ctx-warm .ctxbar i { background: #d4a24a; }
		.ctx-hot .ctxbar i { background: #d44a4a; }
		aside .brand { font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); padding: 0.9rem 1rem 0.6rem; }
		aside .new { margin: 0 0.8rem 0.6rem; }
		#sidebar-swap { overflow-y: auto; flex: 1; padding: 0 0.5rem 0.8rem; }
		aside a.convo { display: block; width: 100%; text-align: left; background: transparent; color: var(--dim); border: 0; border-radius: 8px; padding: 0.45rem 0.6rem; margin: 0.1rem 0; cursor: pointer; font-family: inherit; font-size: 0.85rem; text-decoration: none; }
		aside .convo:hover { background: var(--panel-2); color: var(--text); }
		aside .convo.active { background: #1b2735; color: #cfe2f5; }
		aside .convo .label { display: block; }
		aside .convo .title { display: block; font-size: 0.68rem; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
		header { display: flex; align-items: baseline; gap: 1rem; padding: 0.7rem 1.2rem; border-bottom: 1px solid var(--line); background: var(--panel); }
		header h1 { font-size: 0.85rem; margin: 0; letter-spacing: 0.06em; }
		header .status, #main-swap-header, .hdr { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.7rem; color: var(--dim); margin-left: auto; align-items: center; }
		header .model { color: var(--accent); }
		#notices { padding: 0 1.2rem; }
		#main-swap { flex: 1; overflow-y: auto; padding: 0.4rem 0; }
		#transcript { max-width: 58rem; margin-inline: auto; padding: 0.6rem 1.2rem 1rem; }
		.msg { margin: 0.5rem 0; padding: 0.6rem 0.9rem; border-radius: 10px; border: 1px solid transparent; }
		.msg.user { background: var(--user-bg); border-color: #223042; }
		.msg.assistant { background: var(--agent-bg); border-color: #1e2a20; }
		.msg.event { background: var(--event-bg); color: var(--faint); font-size: 0.78rem; border-color: var(--line); }
		.who { display: block; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--faint); margin-bottom: 0.3rem; }
		.msg.user .who { color: #6f9cc4; } .msg.assistant .who { color: #79a37f; }
		pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; overflow-wrap: anywhere; }
		.msg .body { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
		.msg .body code, details.toolres code { background: #0d1117; border: 1px solid var(--line); border-radius: 4px; padding: 0 0.25rem; font-size: 0.92em; }
		pre.code { background: #0d1117; border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.4rem 0; overflow-x: auto; white-space: pre; }
		.md-h { font-weight: bold; color: #cfe2f5; margin: 0.3rem 0 0.1rem; }
		.msg .body a { color: var(--accent); }
		details.toolres summary { cursor: pointer; list-style: none; color: var(--faint); }
		details.toolres summary:hover { color: var(--dim); }
		details.toolres[open] summary { margin-bottom: 0.3rem; }
		.msg { max-width: 100%; overflow: hidden; }
		.shot { display: block; max-width: min(380px, 100%); max-height: 260px; width: auto; height: auto; border-radius: 8px; margin: 0.45rem 0; border: 1px solid var(--line); }
		.notice { font-size: 0.78rem; padding: 0.25rem 0.6rem; margin: 0.25rem 0; border-left: 3px solid #555; color: var(--dim); }
		.notice.error { border-color: #b55; color: #d99; } .notice.warning { border-color: #b95; }
		.composer { border-top: 1px solid var(--line); background: var(--panel); padding: 0.7rem 1.2rem 0.8rem; }
		.composer-inner { max-width: 58rem; margin-inline: auto; }
		.composer textarea { display: block; width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 0.65rem 0.8rem; font: inherit; min-height: 3.2rem; max-height: 14rem; resize: none; }
		.composer textarea:focus { outline: none; border-color: #35507a; }
		.composer-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
		.attach { cursor: pointer; font-size: 0.78rem; color: var(--dim); border: 1px solid var(--line); border-radius: 8px; padding: 0.3rem 0.65rem; }
		.attach:hover { color: var(--text); background: var(--panel-2); }
		.pulse { color: #7fc47f; animation: pulse 1.2s ease-in-out infinite; }
		@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
		.idle-dot { color: var(--faint); }
		.usage { color: var(--faint); }
		.mode-chips { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
		.chip { border: 0; border-radius: 0; background: transparent; color: var(--dim); font-size: 0.7rem; padding: 0.34rem 0.55rem; cursor: pointer; }
		.chip.on { color: #cfe2f5; background: #1b2735; }
		.attach-row input[type="file"] { display: none; }
		#shot-preview { max-height: 56px; max-width: 90px; border-radius: 6px; border: 1px solid var(--line); }
		.hidden { display: none; }
		.composer-row .spacer { flex: 1; }
		button { background: #24344a; color: #cde; border: 0; border-radius: 8px; padding: 0.42rem 0.9rem; cursor: pointer; font-family: inherit; font-size: 0.8rem; }
		button:hover { filter: brightness(1.15); }
		button.danger { background: #3a2424; color: #ecc; }
		#form-status:empty { display: none; }
		#footer { border-top: 1px solid var(--line); background: var(--panel); font-size: 0.68rem; color: var(--faint); padding: 0.3rem 1.2rem; }
		.footer-strip { max-width: 58rem; margin-inline: auto; display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: center; }
		@media (max-width: 720px) {
			.layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
			#divider { display: none; }
			aside { border-right: 0; border-bottom: 1px solid var(--line); max-height: 30vh; min-width: 0; }
			header { padding: 0.6rem 0.8rem; } #transcript, .composer { padding-inline: 0.7rem; }
		}
	</style>
</head>
<body>
	<div class="layout">
		<aside id="sidebar">
			<div class="brand">durable-homelab</div>
			<div id="sidebar-swap" hx-get="/sidebar" hx-trigger="load, every 8s"></div>
		</aside>
		<div id="divider" title="drag to resize"></div>
		<main>
			<header>
				<h1>durable-homelab</h1>
			<div id="main-swap-header" hx-get="/header" hx-trigger="load, every 8s"></div>
				<button class="new" hx-post="/new" hx-swap="none">+ new</button>
			</header>
			<div id="notices"></div>
			<div id="main-swap" hx-get="/fragment" hx-trigger="load, every 4s"></div>
			<div class="composer">
				<div class="composer-inner">
					<form id="prompt-form">
						<textarea id="prompt-text" name="text" placeholder="prompt — joins the running work (steer)"></textarea>
						<div class="composer-row">
							<label class="attach" for="file" title="прикрепить изображение">📎 attach</label>
						<span class="mode-chips">
							<button type="button" id="mode-inline" class="chip on" title="вставить картинку в сообщение">in msg</button>
							<button type="button" id="mode-file" class="chip" title="сохранить на диск, в промот пойдёт путь">as file</button>
						</span>
						<input type="file" id="file" accept="image/*" multiple class="hidden" />
							<img id="shot-preview" class="hidden" alt="" />
							<span class="spacer"></span>
							<button type="submit">send</button>
							<button type="submit" name="action" value="compact" class="danger">compact</button>
							<button type="submit" name="action" value="abort" class="danger">abort</button>
						</div>
					</form>
					<div id="form-status"></div>
			<div id="footer" hx-get="/footer" hx-trigger="load, every 8s"></div>
				</div>
			</div>
		</main>
	</div>
	<script>
		const paint = (id, html) => {
			const el = document.getElementById(id);
			if (!el) return;
			let stick = false;
			if (id === "main-swap") {
				// pin to bottom only if the user is already at (or near) the bottom
				stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
			}
			el.innerHTML = html;
			if (stick) el.scrollTop = el.scrollHeight;
			if (id === "sidebar-swap") updateUrlFromSidebar(el);
		};
		const refresh = () => fetch("/fragment").then((r) => r.text()).then((html) => paint("main-swap", html));
		const currentConvoId = () => {
			const m = /^\\/(\\d+)$/.exec(location.pathname);
			return m ? m[1] : null;
		};
		const updateUrlFromSidebar = (el) => {
			const act = el.querySelector(".convo.active");
			if (!act) return;
			const m = /"id":(\\d+)/.exec(act.getAttribute("hx-vals") || "");
			// correct stray paths silently; deliberate navigation gets its own history entry via the click handler
			if (m && location.pathname !== "/" + m[1]) history.replaceState(null, "", "/" + m[1]);
		};
		document.body.addEventListener("htmx:afterSwap", (e) => {
			if (e.target && e.target.id === "sidebar-swap") updateUrlFromSidebar(e.target);
		});
		document.addEventListener("click", (e) => {
			const a = e.target.closest("a.convo");
			if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
			if (a.getAttribute("href") === location.pathname) return;
			history.pushState(null, "", a.getAttribute("href"));
		});
		window.addEventListener("popstate", () => {
			const id = currentConvoId() ?? "1";
			fetch("/switch", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "id=" + id })
				.then(() => { refresh(); loadDraft(id); })
				.catch(() => {});
		});
		const es = new EventSource("/events");
		es.addEventListener("main", (e) => paint("main-swap", e.data));
		es.addEventListener("sidebar", (e) => paint("sidebar-swap", e.data));
		es.addEventListener("header", (e) => paint("main-swap-header", e.data));
		es.addEventListener("footer", (e) => paint("footer", e.data));
		htmx.on("htmx:load", refresh);
		const form = document.getElementById("prompt-form");
		const ta = document.getElementById("prompt-text");
		const fileInput = document.getElementById("file");
		const preview = document.getElementById("shot-preview");
		const statusEl = document.getElementById("form-status");
		const status = (msg, cls = "info") => { statusEl.innerHTML = '<div class="notice ' + cls + '">' + msg + "</div>"; };
		let delivery = "inline";
		const setMode = (m) => {
			delivery = m;
			document.getElementById("mode-inline").classList.toggle("on", m === "inline");
			document.getElementById("mode-file").classList.toggle("on", m === "file");
		};
		setMode("inline");
		document.getElementById("mode-inline").addEventListener("click", () => setMode("inline"));
		document.getElementById("mode-file").addEventListener("click", () => setMode("file"));
		ta.addEventListener("input", () => {
			ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 224) + "px";
			try { localStorage.setItem("draft:" + (currentConvoId() ?? "1"), ta.value); } catch (_e) {}
		});
		const loadDraft = (id) => {
			let v = "";
			try { v = localStorage.getItem("draft:" + id) ?? ""; } catch (_e) {}
			ta.value = v;
			ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 224) + "px";
		};
		// keep the draft in sync when the shown conversation changes
		new MutationObserver(() => {
			const id = currentConvoId();
			if (id !== null && ta.value !== (localStorage.getItem("draft:" + id) ?? "")) loadDraft(id);
		}).observe(document.getElementById("main-swap-header"), { childList: true, subtree: false, characterData: false });
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && !e.target.closest("textarea")) {
				fetch("/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "abort" }) })
					.then(() => status("aborted", "warning")).catch(() => {});
			}
		});
		fileInput.addEventListener("change", () => {
			const f = fileInput.files[0];
			if (f) { preview.src = URL.createObjectURL(f); preview.classList.remove("hidden"); }
			else { preview.classList.add("hidden"); preview.src = ""; }
		});
		const toBlocks = async () => {
			const blocks = [];
			const text = ta.value;
			if (text.trim()) blocks.push({ type: "text", text: text });
			for (const f of fileInput.files) {
				const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
				const m = /^data:([^;]+);base64,([\\s\\S]*)$/.exec(data);
				if (m) blocks.push({ type: "image", mimeType: m[1], data: m[2] });
			}
			return blocks;
		};
		loadDraft(currentConvoId() ?? "1");
		// resizable sidebar
		try {
			const saved = localStorage.getItem("sbw");
			if (saved) document.documentElement.style.setProperty("--sbw", saved + "px");
		} catch (_e) {}
		const divider = document.getElementById("divider");
		divider.addEventListener("mousedown", (e) => {
			e.preventDefault();
			divider.classList.add("drag");
			const move = (ev) => {
				const w = Math.max(170, Math.min(520, ev.clientX));
				document.documentElement.style.setProperty("--sbw", w + "px");
			};
			const up = (ev) => {
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", up);
				divider.classList.remove("drag");
				const w = Math.max(170, Math.min(520, ev.clientX));
				try { localStorage.setItem("sbw", String(w)); } catch (_e) {}
			};
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", up);
		});
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const btn = e.submitter || document.activeElement;
			const action = btn && btn.name === "action" ? btn.value : null;
			const text = ta.value;
			try {
				if (action === "abort") { await fetch("/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: action }) }); }
				else if (action === "compact") { await fetch("/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: action, instructions: text }) }); status("compacting"); }
				else {
					const blocks = await toBlocks();
					if (!text && blocks.length === 0) return;
					await fetch("/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(delivery === "file" ? { text: text, blocks: blocks, delivery: "file" } : { text: text, blocks: blocks }) });
				}
				form.reset(); fileInput.value = ""; preview.classList.add("hidden"); preview.src = "";
				try { localStorage.removeItem("draft:" + (currentConvoId() ?? "1")); } catch (_e) {}
				ta.style.height = "auto";
				status("sent");
				refresh();
			} catch (err) { status(String(err).slice(0, 300), "error"); }
		});
	</script>
</body>
</html>
`;

const readBody = (request: IncomingMessage): Promise<string> =>
	new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => resolve(body));
	});

const formValue = (body: string, name: string): string => {
	const params = new URLSearchParams(body);
	return params.get(name) ?? "";
};

const SSE = (event: string, html: string): string =>
	`event: ${event}\ndata: ${html.split("\n").join("\ndata: ")}\n\n`;

/** SSE + htmx web surface: the server renders DurableView fragments; the browser swaps them. */
export function createWebServer(
	view: { current(): DurableView; subscribe(listener: () => void): () => void },
	controller: DurableController,
	port: number,
): { wire(viewGetter: () => DurableView): void; server: import("node:http").Server; close(): Promise<void> } {
	const clients = new Set<ServerResponse>();
	let renderTimer: NodeJS.Timeout | undefined;
	const push = (): void => {
		if (renderTimer !== undefined) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			const current = viewNow();
			const payload = SSE("main", renderMain(current)) + SSE("sidebar", renderSidebar(current)) + SSE("header", renderHeader(current)) + SSE("footer", renderFooter(current));
			for (const client of clients) client.write(payload);
		}, 120);
	};
	let viewNow: () => DurableView = () => {
		throw new Error("view not wired");
	};

	const server = createServer(async (request, response) => {
		const url = (request.url ?? "/").split("?")[0];
		try {
			if (url === "/" || url === "/index.html") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(PAGE);
				return;
			}
			// deep link: /<conversationId> switches to that session, then renders
			const convoLink = /^\/(\d+)$/.exec(url);
			if (convoLink) {
				const cid = Number(convoLink[1]);
				if (Number.isFinite(cid) && cid !== activeId(viewNow())) await controller.switchConversation(cid);
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(PAGE);
				return;
			}
			if (url === "/vendor/htmx.min.js") {
				response.writeHead(200, { "content-type": "text/javascript" });
				response.end(readFileSync(join(process.cwd(), "vendor", "htmx.min.js")));
				return;
			}
			if (url.startsWith("/img/")) {
				const file = join(IMG_CACHE_DIR, url.slice("/img/".length));
				if (!/^[-\w]+\.(png|jpg|webp|gif)$/.test(url.slice(5)) || !existsSync(file)) {
					response.writeHead(404);
					response.end("not found");
					return;
				}
				const ext = file.slice(-3) === "jpg" ? "jpeg" : file.slice(-3);
				response.writeHead(200, { "content-type": `image/${ext}`, "cache-control": "public, max-age=31536000, immutable" });
				response.end(readFileSync(file));
				return;
			}
			if (url === "/fragment" || url === "/sidebar" || url === "/header" || url === "/footer") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				const v = viewNow();
				response.end(
					url === "/fragment"
						? renderMain(v)
						: url === "/sidebar"
							? renderSidebar(v)
							: url === "/header"
								? renderHeader(v)
								: renderFooter(v),
				);
				return;
			}
			if (url === "/events") {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				response.write(SSE("main", renderMain(viewNow())) + SSE("sidebar", renderSidebar(viewNow())) + SSE("header", renderHeader(viewNow())) + SSE("footer", renderFooter(viewNow())));
				clients.add(response);
				const heartbeat = setInterval(() => response.write(": ping\n\n"), 15000);
				request.on("close", () => {
					clearInterval(heartbeat);
					clients.delete(response);
				});
				return;
			}
			if (url === "/submit" && request.method === "POST") {
				const body = await readBody(request);
				if ((request.headers["content-type"] ?? "").includes("application/json")) {
					const j = JSON.parse(body);
					if (j.action === "abort") void controller.abort();
					else if (j.action === "compact") void controller.compact(j.instructions ?? undefined);
					else if (j.delivery === "file") {
						// pi-web style "folder" delivery: images land on disk, prompt references paths
						const dir = join(process.cwd(), "attachments");
						mkdirSync(dir, { recursive: true });
						let text = String(j.text ?? "");
						const stamps = new Date().toISOString().replace(/[:.]/g, "-");
						let n = 0;
						for (const block of j.blocks ?? []) {
							if (block.type === "image") {
								const ext = IMG_MIME[block.mimeType] ?? "png";
								n += 1;
								const path = join(dir, `${stamps}-${n}.${ext}`);
								writeFileSync(path, Buffer.from(String(block.data), "base64"));
								text += `\n[attachment: ${path}]`;
							} else if (block.type === "text" && String(block.text ?? "").length > 0) {
								text = text.length > 0 ? `${text}\n${block.text}` : String(block.text);
							}
						}
						if (text.trim().length > 0) void controller.submit(text, "steer");
					} else void controller.submit(j.text ?? "", "steer", j.blocks);
				} else {
					const action = formValue(body, "action");
					const text = formValue(body, "text").trim();
					if (action === "abort") void controller.abort();
					else if (action === "compact") void controller.compact(text.length > 0 ? text : undefined);
					else if (text.length > 0) void controller.submit(text, "steer");
				}
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end('<div id="form-status" class="notice info">sent</div>');
				return;
			}
			if (url === "/switch" && request.method === "POST") {
				const id = Number(formValue(await readBody(request), "id"));
				if (Number.isFinite(id)) void controller.switchConversation(id);
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end("");
				return;
			}
			if (url === "/new" && request.method === "POST") {
				void controller.createConversation();
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end("");
				return;
			}
			response.writeHead(404);
			response.end("not found");
		} catch (error) {
			response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			response.end(error instanceof Error ? error.message : String(error));
		}
	});

	return {
		wire(viewGetter: () => DurableView): void {
			viewNow = viewGetter;
			view.subscribe(push);
		},
		server,
		close: () =>
			new Promise((resolve) => {
				for (const client of clients) client.end();
				server.close(() => resolve());
			}),
	};
}
