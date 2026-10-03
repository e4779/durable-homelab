// Boot smoke: the harness opens without credentials and the web surface serves.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "dh-agent-"));
const child = spawn(process.execPath, ["src/serve.ts"], {
	env: { ...process.env, PI_AGENT_DIR: agentDir, PORT: "8791", KN_DIR: join(agentDir, "kn") },
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const deadline = Date.now() + 25_000;
let up = false;
while (Date.now() < deadline && !up) {
	await new Promise((r) => setTimeout(r, 500));
	up = out.includes("web surface on");
}
if (!up) {
	console.error("smoke FAIL: server never became ready\n" + out.slice(-2000));
	child.kill("SIGKILL");
	process.exit(1);
}
const res = await fetch("http://127.0.0.1:8791/fragment");
const body = await res.text();
child.kill("SIGKILL");
if (res.status !== 200 || !body.includes("transcript")) {
	console.error("smoke FAIL: fragment " + res.status);
	process.exit(1);
}
console.log("smoke OK: harness opened, fragment rendered (" + body.length + " bytes)");
