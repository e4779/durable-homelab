#!/usr/bin/env node
import { openDurable } from "./runtime.ts";

// M1 verification: the harness opens outside the monorepo and zai models resolve.
const durable = await openDurable({});
try {
	const view = durable.view.current();
	console.log("session:", view.session.id);
	console.log("cwd:", view.session.cwd);
	console.log("models:");
	for (const m of view.models) console.log("  -", `${m.provider}/${m.modelId}`, `(\u001b[2m${m.name}, ctx ${m.contextWindow}\u001b[0m)`);
	console.log("conversations:", view.conversations.map((c) => c.label).join(", ") || "(main only)");
} finally {
	await durable.close();
}
