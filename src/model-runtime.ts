import { builtinModels, type Model } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";
import { createAuthJsonCredentials } from "./credentials.ts";

/**
 * The zai provider authenticates from env (ZAI_API_KEY). pi stores the coding-plan
 * key in auth.json — bridge it into the environment before Models is created.
 */
function bridgeZaiKey(): void {
	try {
		const auth = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
		const entry = auth?.zai;
		if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0) {
			process.env.ZAI_API_KEY ??= entry.key;
		}
	} catch {}
}

/** pi-ai Models with every built-in provider (zai included) and pi auth.json credentials. */
export function createModelRuntime(): MutableModels {
	bridgeZaiKey();
	return builtinModels({ credentials: createAuthJsonCredentials() as any });
}

/** The homelab default: zai glm-5.3-flash among the auth-available models. */
export async function defaultModelRef(models: MutableModels): Promise<{ provider: string; modelId: string } | undefined> {
	const available = (await models.getAvailable("zai")) as readonly Model<any>[];
	const pick = available.find((m) => /glm-5\.3-flash/.test(m.id));
	if (pick === undefined) return undefined;
	return { provider: "zai", modelId: pick.id };
}
