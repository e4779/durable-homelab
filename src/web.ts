import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
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
		.flatMap((block: any) => (block.type === "text" ? [block.text] : block.type === "tool_call" ? [`[tool: ${block.name}]`] : []))
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
			parts.push(`<div class="msg user"><span class="who">you</span><pre>${esc(text)}</pre></div>`);
		} else if (entry.kind === "pi.assistant" || entry.kind === "pi.message") {
			parts.push(`<div class="msg assistant"><span class="who">agent</span><pre>${esc(text)}</pre></div>`);
		} else {
			parts.push(`<div class="msg event"><span class="who">${esc(entry.kind)}</span><pre>${esc(text.slice(0, 400))}</pre></div>`);
		}
	}
	if (windowed.length < entries.length) parts.unshift(`<div class="msg event">… ${entries.length - windowed.length} older entries in storage …</div>`);
	return parts.join("\n");
}

const activeId = (view: DurableView): number => view.conversation.conversation?.id ?? -1;

function renderMain(view: DurableView): string {
	const model = view.conversation.docs?.["pi.agent"]?.model;
	const notices = view.notices
		.slice(-5)
		.map((n) => `<div class="notice ${n.level}">${esc(n.message)}</div>`)
		.join("\n");
	return `
<div class="status">
	<span class="model">${esc(model ? `${model.provider}/${model.modelId}` : "no model")}</span>
	<span class="session">${esc(view.session.id)}</span>
</div>
<div id="notices">${notices}</div>
<div id="transcript">${transcript(view)}</div>`;
}

function renderSidebar(view: DurableView): string {
	const active = activeId(view);
	const items = view.conversations
		.map(
			(c) =>
				`<button class="convo${c.id === active ? " active" : ""}" hx-post="/switch" hx-vals='{"id":${c.id}}' hx-swap="none">` +
				`<span class="label">${esc(c.label)}</span>${c.title ? `<span class="title">${esc(c.title.slice(0, 60))}</span>` : ""}</button>`,
		)
		.join("\n");
	return `
<button class="new" hx-post="/new" hx-swap="none">+ new session</button>
<div id="convos">${items}</div>`;
}

const PAGE = `
<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>durable-homelab</title>
	<script src="/vendor/htmx.min.js"></script>
	<script src="/vendor/ext/sse.js"></script>
	<style>
		:root { color-scheme: dark; }
		* { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #111; color: #ddd; margin: 0; }
		.layout { display: grid; grid-template-columns: 240px 1fr; gap: 1rem; max-width: 68rem; margin-inline: auto; padding: 1rem; }
		aside { border-right: 1px solid #222; padding-right: 0.8rem; }
		aside .brand { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #666; margin-bottom: 0.6rem; }
		aside .new { width: 100%; margin-bottom: 0.6rem; }
		aside .convo { display: block; width: 100%; text-align: left; background: transparent; color: #999; border: 0; border-radius: 6px; padding: 0.4rem 0.5rem; margin: 0.15rem 0; cursor: pointer; }
		aside .convo.active { background: #1d2a3a; color: #cde; }
		aside .convo .label { display: block; font-size: 0.85rem; }
		aside .convo .title { display: block; font-size: 0.7rem; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		main { min-width: 0; }
		h1 { font-size: 1rem; margin: 0 0 0.6rem; }
		.status { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.75rem; color: #888; margin-bottom: 0.5rem; }
		.msg { margin: 0.4rem 0; padding: 0.5rem 0.7rem; border-radius: 8px; }
		.msg.user { background: #1d2a3a; } .msg.assistant { background: #1a1f1a; } .msg.event { background: #1b1b1b; color: #777; font-size: 0.8rem; }
		.who { display: block; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 0.25rem; }
		pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; }
		.notice { font-size: 0.8rem; padding: 0.2rem 0.6rem; margin: 0.2rem 0; border-left: 3px solid #555; color: #aaa; }
		.notice.error { border-color: #b55; color: #d99; } .notice.warning { border-color: #b95; }
		form { display: flex; gap: 0.5rem; margin-top: 1rem; position: sticky; bottom: 0; background: #111; padding: 0.5rem 0; }
		textarea { flex: 1; background: #181818; color: #ddd; border: 1px solid #333; border-radius: 8px; padding: 0.6rem; font: inherit; min-height: 3rem; }
		button { background: #24344a; color: #cde; border: 0; border-radius: 8px; padding: 0.5rem 0.9rem; cursor: pointer; font-family: inherit; }
		button.danger { background: #3a2424; color: #ecc; }
		@media (max-width: 720px) { .layout { grid-template-columns: 1fr; padding: 0.6rem; } aside { border-right: 0; border-bottom: 1px solid #222; padding: 0 0 0.6rem; } }
	</style>
</head>
<body>
	<div class="layout">
		<aside id="sidebar" hx-ext="sse" sse-connect="/events">
			<div class="brand">durable-homelab</div>
			<div sse-swap="sidebar" hx-swap="innerHTML" hx-get="/sidebar" hx-trigger="load, every 8s"></div>
		</aside>
		<main>
			<h1>durable-homelab</h1>
			<div hx-ext="sse" sse-connect="/events">
				<div sse-swap="main" hx-swap="innerHTML" hx-get="/fragment" hx-trigger="load, every 4s"></div>
			</div>
			<form hx-post="/submit" hx-target="#form-status" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
				<textarea name="text" placeholder="prompt — joins the running work (steer)"></textarea>
				<button type="submit">send</button>
				<button type="submit" name="action" value="compact" class="danger">compact</button>
				<button type="submit" name="action" value="abort" class="danger">abort</button>
			</form>
			<div id="form-status"></div>
		</main>
	</div>
</body>
</html>
`;

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => resolve(body));
	});
}

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
			const view = viewNow();
			const payload = SSE("main", renderMain(view)) + SSE("sidebar", renderSidebar(view));
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
			if (url === "/vendor/htmx.min.js") {
				response.writeHead(200, { "content-type": "text/javascript" });
				response.end(readFileSync(join(process.cwd(), "vendor", "htmx.min.js")));
				return;
			}
			if (url === "/vendor/ext/sse.js") {
				response.writeHead(200, { "content-type": "text/javascript" });
				response.end(readFileSync(join(process.cwd(), "vendor", "ext", "sse.js")));
				return;
			}
			if (url === "/fragment" || url === "/sidebar") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(url === "/fragment" ? renderMain(viewNow()) : renderSidebar(viewNow()));
				return;
			}
			if (url === "/events") {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				const send = (event: string, html: string): void =>
					response.write(SSE(event, html));
				send("main", renderMain(viewNow()));
				send("sidebar", renderSidebar(viewNow()));
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
				const action = formValue(body, "action");
				const text = formValue(body, "text").trim();
				if (action === "abort") void controller.abort();
				else if (action === "compact") void controller.compact(text.length > 0 ? text : undefined);
				else if (text.length > 0) void controller.submit(text, "steer");
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
