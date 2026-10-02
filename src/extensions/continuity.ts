import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

const FILE = join(process.cwd(), "continuity.md");

function read(): string {
	return existsSync(FILE) ? readFileSync(FILE, "utf8") : "(empty — nothing recorded yet)";
}

/** Long-term continuity: a section the model always sees + an append-only tool. */
export const Continuity = defineExtension({
	name: "continuity",
	sections: [section("continuity", () => "# Continuity\n\n" + read())],
	tools: [
		defineTool({
			name: "continuity_note",
			description:
				"Append a durable note to the continuity log (decisions, state, what was done and why). The note is injected into your system prompt on every future request.",
			parameters: Type.Object({ note: Type.String({ description: "One short paragraph: decision/state/next step" }) }),
			execute: async (args) => {
				const stamp = new Date().toISOString().slice(0, 16);
				appendFileSync(FILE, `- [${stamp}] ${args.note.replace(/\s+/g, " ").trim()}\n`);
				return { content: [{ type: "text", text: "Noted." }] };
			},
		}),
	],
});
