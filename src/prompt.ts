import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

const IDENTITY = `You are the durable-homelab agent on hlab (192.168.1.3, Debian).
Be concise and tool-first: prefer running a command over describing it.
The user speaks Russian; reply in Russian. Internal reasoning stays in English.`;

/** Identity + project context, rebuilt before every request by the harness. */
export const HomelabPrompt = defineExtension({
	name: "homelab-prompt",
	sections: [
		section("identity", () => IDENTITY),
		section("project", () => {
			for (const name of ["AGENTS.md", "README.md"]) {
				try {
					const path = join(process.cwd(), name);
					if (existsSync(path)) return readFileSync(path, "utf8");
				} catch {}
			}
			return "";
		}),
	],
});
