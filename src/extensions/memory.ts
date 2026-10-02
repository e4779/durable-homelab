import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const run = promisify(execFile);
const KN = process.env.KN_DIR ?? "/home/e4779/kn";

const KnSearch = defineTool({
	name: "kn_search",
	description: "Search the personal knowledge base (~/kn, OKF markdown concepts). Returns matching file paths and matching lines. Use before starting work that might already have research.",
	parameters: Type.Object({ query: Type.String({ description: "Text to search for (plain words; regex allowed)" }) }),
	replay: "safe",
	execute: async (args) => {
		try {
			const { stdout } = await run("rg", ["-i", "--no-heading", "-l", args.query, join(KN, "bundles")], { timeout: 10000 });
			const files = stdout.trim().split("\n").filter(Boolean).slice(0, 12);
			if (files.length === 0) return { content: [{ type: "text", text: "No matches in kn." }] };
			const snippets: string[] = [];
			for (const file of files.slice(0, 5)) {
				try {
					const s = await run("rg", ["-i", "--no-heading", "-m", "3", args.query, file], { timeout: 5000 });
					snippets.push(file.replace(KN + "/", "") + "\n  " + s.stdout.trim().split("\n").join("\n  "));
				} catch (e) {}
			}
			return {
				content: [{ type: "text", text: ("Files:\n" + files.join("\n") + "\n\nSnippets:\n" + snippets.join("\n")).slice(0, 4000) }],
			};
		} catch (e) {
			return { content: [{ type: "text", text: "No matches in kn." }] };
		}
	},
});

export const Memory = defineExtension({
	name: "memory",
	tools: [KnSearch],
});
