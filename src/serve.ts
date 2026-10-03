#!/usr/bin/env node
import { openDurable } from "./runtime.ts";
import { createWebServer } from "./web.ts";

const port = Number(process.env.PORT ?? 8642);

// First run on a fresh agent dir has no sessions yet — bootstrap one.
let durable;
try {
	durable = await openDurable({ continueSession: true });
} catch (error) {
	if (!String(error).includes("No durable session exists")) throw error;
	durable = await openDurable({ continueSession: false });
}
const web = createWebServer(durable.view, durable.controller, port);
web.wire(() => durable.view.current());
web.server.listen(port);
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
