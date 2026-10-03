/**
 * Preflight smoke test: import the surface and render every fragment against a
 * mock view. Wired as systemd ExecStartPre — a broken web.ts fails here and
 * systemd refuses to restart-loop the real service. Zero dependencies.
 */
import { renderMain, renderSidebar, renderHeader, createWebServer, renderMarkdown } from "../src/web.ts";

const view: any = {
	session: { id: "smoke", directory: "/tmp", cwd: "/home/e4779/projects/durable-homelab" },
	conversations: [
		{ id: 1, label: "main" },
		{ id: 135, label: "session 135", title: "t", cwd: "/home/e4779/projects/durable-homelab" },
	],
	conversation: {
		conversation: { id: 135 },
		entries: [
			{ kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "hello **world**" }] }] },
			{ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] },
			{ kind: "pi.tool-result", model: [], data: {} },
		],
		docs: { "pi.agent": { model: { provider: "zai", modelId: "glm-5.3-flash" } }, "pi.usage": { models: { "zai/glm": { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } } } },
	},
	models: [{ provider: "zai", modelId: "glm-5.3-flash", name: "glm", contextWindow: 1_000_000 }],
	projects: ["/home/e4779/projects/durable-homelab"],
	notices: [],
};

const checks: Array<[string, () => string]> = [
	["renderMain", () => renderMain(view)],
	["renderSidebar", () => renderSidebar(view)],
	["renderHeader", () => renderHeader(view)],
	["renderMarkdown", () => renderMarkdown("# hi\n```js\nx\n```")],
];

let failed = false;
for (const [name, fn] of checks) {
	try {
		const out = fn();
		if (/\bundefined\b/.test(out) || /\)\}\</.test(out)) throw new Error(`suspicious output: ${out.slice(0, 120)}`);
		console.log(`smoke ${name}: ok (${out.length} bytes)`);
	} catch (e) {
		failed = true;
		console.error(`smoke ${name}: FAIL — ${e instanceof Error ? e.message : e}`);
	}
}

// the HTTP surface must at least construct
try {
	const fakeView = { current: () => view, subscribe: () => () => {} };
	const fakeController = new Proxy({}, { get: () => async () => {} });
	const server = createWebServer(fakeView as any, fakeController as any, 0);
	void server.close();
	console.log("smoke createWebServer: ok");
} catch (e) {
	failed = true;
	console.error(`smoke createWebServer: FAIL — ${e instanceof Error ? e.message : e}`);
}

if (failed) {
	console.error("SMOKE FAILED — refusing to start");
	process.exit(1);
}
console.log("smoke: all green");
