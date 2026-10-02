#!/usr/bin/env node
import { openDurable } from "./runtime.ts";
import { createWebServer } from "./web.ts";

const port = Number(process.env.PORT ?? 8642);
const durable = await openDurable({ continueSession: true });
const web = createWebServer(durable.view, durable.controller, port);
console.log(`durable-homelab web surface on http://0.0.0.0:${port}`);

const shutdown = (): void => {
	void (async () => {
		await web.close();
		await durable.close();
		process.exit(0);
	})();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
