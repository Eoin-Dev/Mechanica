import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const browserTestModule = require.resolve("@playwright/test");
const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const baseConfig = fileURLToPath(new URL("../playwright.config.ts", import.meta.url));

/** Exercise the installed CLI and actual release configuration. These small
 * fixtures do not request a browser or start an application server. */
function runGate(t, source, ci = true) {
  const root = mkdtempSync(path.join(tmpdir(), "mechanica-browser-gate-"));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith("mechanica-browser-gate-")) {
      throw new Error("Unexpected browser-gate fixture cleanup path");
    }
    rmSync(root, { recursive: true, force: true });
  });
  const config = path.join(root, "gate.config.ts");
  writeFileSync(config, `import config from ${JSON.stringify(baseConfig)};
export default {
  ...config,
  testDir: ${JSON.stringify(root)},
  testMatch: "gate.spec.ts",
  outputDir: ${JSON.stringify(path.join(root, "results"))},
  projects: [{ name: "release-gate" }],
  ${ci ? "" : "retries: 1,"}
};`);
  writeFileSync(path.join(root, "gate.spec.ts"),
    `import { test, expect } from ${JSON.stringify(browserTestModule)};\n${source}`);
  const result = spawnSync(process.execPath,
    [cli, "test", "--config", config, "--reporter=json"], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, CI: ci ? "true" : "" },
    });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test("the CI browser gate accepts a complete clean pass", t => {
  const { status, report } = runGate(t,
    'test("clean", () => expect(2 + 2).toBe(4));');
  assert.equal(status, 0);
  assert.equal(report.stats.expected, 1);
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.skipped, 0);
});

test("a browser case that passes only on retry still blocks CI publication", t => {
  const { status, report } = runGate(t,
    'test("retry-only", async ({}, info) => expect(info.retry).toBeGreaterThan(0));');
  assert.equal(report.stats.flaky, 1);
  assert.equal(report.suites[0].specs[0].tests[0].results.length, 2);
  assert.equal(status, 1);
});

test("ordinary failed browser cases exhaust retries and block CI publication", t => {
  const { status, report } = runGate(t,
    'test("failed", () => expect(2 + 2).toBe(5));');
  assert.equal(status, 1);
  assert.equal(report.stats.unexpected, 1);
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.suites[0].specs[0].tests[0].results.length, 3);
});

test("exclusive browser cases cannot silently narrow CI acceptance", t => {
  const { status, report } = runGate(t,
    'test.only("exclusive", () => expect(true).toBe(true));');
  assert.equal(status, 1);
  assert.match(JSON.stringify(report.errors), /forbidOnly|test\.only/);
});

test("an explicitly retried local diagnostic run remains available", t => {
  const { status, report } = runGate(t,
    'test("local-retry", async ({}, info) => expect(info.retry).toBeGreaterThan(0));', false);
  assert.equal(status, 0);
  assert.equal(report.stats.flaky, 1);
  assert.equal(report.suites[0].specs[0].tests[0].results.length, 2);
});
