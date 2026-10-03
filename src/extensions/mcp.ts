import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/**
 * MCP bridge over mcporter's runtime API (same approach as pi-fabric):
 * reads ~/.mcporter/mcporter.json, connects on demand (stdio + HTTP, OAuth
 * disabled — headless), exposes every server's tools through three meta-tools.
 * The runtime is created lazily so a missing/broken mcporter never blocks the
 * harness. Import is dynamic for the same reason.
 */

type Runtime = {
	listServers(): string[];
	listTools(server: string, options?: { includeSchema?: boolean; disableOAuth?: boolean }): Promise<
		readonly { name: string; description?: string; inputSchema?: unknown }[]
	>;
	callTool(server: string, toolName: string, options?: { args?: unknown; timeoutMs?: number; disableOAuth?: boolean }): Promise<unknown>;
	close(server?: string): Promise<void>;
};

let runtimePromise: Promise<Runtime> | undefined;

const getRuntime = async (): Promise<Runtime> => {
	if (runtimePromise === undefined) {
		runtimePromise = import("mcporter").then(({ createRuntime }) =>
			createRuntime({
				clientInfo: { name: "durable-homelab", version: "0.1.0" },
				disableOAuth: true,
				callTimeoutMs: 60_000,
			}) as Promise<Runtime>,
		);
	}
	return runtimePromise;
};

const text = (s: string): ToolExecutionResult => ({ content: [{ type: "text", text: s }] });

const Servers = defineTool({
	name: "mcp_servers",
	description:
		"List configured MCP servers (from ~/.mcporter/mcporter.json) with their tools (names + short descriptions). " +
		"Use mcp_tools for a tool's JSON-schema arguments, then mcp_call to invoke.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		try {
			const rt = await getRuntime();
			const lines: string[] = [];
			for (const server of rt.listServers()) {
				try {
					const tools = await rt.listTools(server, { includeSchema: false, disableOAuth: true });
					lines.push(`${server}: ${tools.map((t) => t.name).join(", ")}`);
				} catch (e) {
					lines.push(`${server}: unavailable (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
				}
			}
			return text(lines.length > 0 ? lines.join("\n") : "No MCP servers configured.");
		} catch (e) {
			return text(`mcp_servers failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	},
});

const Tools = defineTool({
	name: "mcp_tools",
	description: "Show JSON-schema arguments of every tool on one MCP server. Call before using a tool the first time.",
	parameters: Type.Object({ server: Type.String({ description: "MCP server name, e.g. chrome-devtools" }) }),
	replay: "safe",
	execute: async (args) => {
		try {
			const rt = await getRuntime();
			const tools = await rt.listTools(args.server, { includeSchema: true, disableOAuth: true });
			const rendered = tools
				.map((t) => `${t.name}${t.description ? ` — ${t.description.slice(0, 160)}` : ""}\n  args: ${JSON.stringify(t.inputSchema ?? {})}`)
				.join("\n");
			return text(rendered.slice(0, 12_000));
		} catch (e) {
			return text(`mcp_tools failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	},
});

const Call = defineTool({
	name: "mcp_call",
	description: "Invoke a tool on an MCP server. Use mcp_servers to discover servers/tools and mcp_tools for argument schemas.",
	parameters: Type.Object({
		server: Type.String({ description: "MCP server name, e.g. chrome-devtools" }),
		tool: Type.String({ description: "Tool name on that server" }),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments object" })),
	}),
	execute: async (args) => {
		try {
			const rt = await getRuntime();
			const result = (await rt.callTool(args.server, args.tool, {
				args: args.args ?? {},
				disableOAuth: true,
			})) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
			const parts = (result?.content ?? [])
				.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
				.join("\n");
			return text((result?.isError ? "MCP tool error: " : "") + (parts || JSON.stringify(result)).slice(0, 12_000));
		} catch (e) {
			return text(`mcp_call failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	},
});

export const Mcp = defineExtension({
	name: "mcp",
	tools: [Servers, Tools, Call],
});
