import { createRegistry, type EnvTarget, type HarnessSettings, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { HomelabPrompt } from "./prompt.ts";
import { Memory } from "./extensions/memory.ts";
import { Continuity } from "./extensions/continuity.ts";
import { Mcp } from "./extensions/mcp.ts";
import { harnessSettings } from "./settings.ts";

/**
 * M1: pi's HTTP dispatcher is skipped — default fetch reaches api.z.ai from this box.
 * Port core/http-dispatcher.ts (113 lines) only if provider streams break off.
 */
export function configureHarnessHttp(): void {}

export function harnessSettingsFor(): HarnessSettings {
	return harnessSettings();
}

/** Coding tools from the durable package + the homelab prompt. */
export function createCodingRegistry(_cwd: string): Registry {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(HomelabPrompt);
	registry.install(Memory);
	registry.install(Continuity);
	registry.install(Mcp);
	return registry;
}

/** One execution environment per directory, shared by every conversation in it. */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	};

	async cleanup(context: any): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
	}
}
