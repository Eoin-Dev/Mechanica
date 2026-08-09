import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const server = await preview({
  root,
  logLevel: "warn",
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});

let child;
const forwardSignal = (signal) => {
  if (child !== undefined && child.exitCode === null) child.kill(signal);
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

try {
  child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, PLAYWRIGHT_BASE_URL: "http://127.0.0.1:4173" },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  process.exitCode = code ?? 1;
} finally {
  await server.close();
}
