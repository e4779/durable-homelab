import { homedir } from "node:os";
import { join } from "node:path";

/** pi's agent dir: credentials (auth.json) and settings live there. */
export function getAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
