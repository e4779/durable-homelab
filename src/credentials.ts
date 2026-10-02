import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";

/**
 * Minimal pi-ai CredentialStore over pi's auth.json ({ providerId: { type, key } }).
 * Read-only: credentials are managed by pi (/login); this agent never writes them.
 */
export function createAuthJsonCredentials(): any {
	const path = () => join(getAgentDir(), "auth.json");
	const load = (): Record<string, any> => {
		try {
			return JSON.parse(readFileSync(path(), "utf8")) ?? {};
		} catch {
			return {};
		}
	};
	return {
		async read(providerId: string) {
			const entry = load()[providerId];
			return typeof entry === "object" && entry !== null ? entry : undefined;
		},
		async list() {
			return Object.entries(load()).map(([providerId, c]: [string, any]) => ({
				providerId,
				type: c?.type,
			}));
		},
		async write() {
			throw new Error("durable-homelab is read-only for credentials; use pi /login");
		},
	};
}
