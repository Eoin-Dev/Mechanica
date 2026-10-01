import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkTestCount } from "./check-test-count.mjs";

const readme = "![tests](https://img.shields.io/badge/tests-10%2B%20passing-success)";
const passed = {
  success: true, numTotalTests: 20, numPassedTests: 20,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
};

test("the badge accepts a complete passing report above its lower bound", () => {
  assert.match(checkTestCount(readme, passed), /20\. OK\.$/);
  assert.match(checkTestCount(readme, { ...passed, numTotalTests: 10, numPassedTests: 10 }), /10\. OK\.$/);
});

test("malformed counts cannot pass through coercion or incomplete fields", () => {
  for (const field of ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]) {
    for (const invalid of ["unknown", "20", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
      assert.throws(() => checkTestCount(readme, { ...passed, [field]: invalid }), new RegExp(field));
    }
  }
  for (const invalid of [null, false, [], "report", 20]) {
    assert.throws(() => checkTestCount(readme, invalid), /must be an object/);
  }
});

test("failed, skipped, pending and contradictory reports fail even with enough passing tests", () => {
  for (const success of [false, undefined, "true", 1]) {
    assert.throws(() => checkTestCount(readme, { ...passed, success }), /successful run/);
  }
  for (const partial of [
    { numPassedTests: 19 }, { numPassedTests: 21 }, { numFailedTests: 1 },
    { numPendingTests: 1 }, { numTodoTests: 1 },
  ]) assert.throws(() => checkTestCount(readme, { ...passed, ...partial }), /inconsistent test counts/);
  for (const field of ["numFailedTestSuites", "numRuntimeErrorTestSuites"]) {
    for (const invalid of [1, -1, "0", NaN, null]) {
      assert.throws(() => checkTestCount(readme, { ...passed, [field]: invalid }), new RegExp(field));
    }
  }
});

test("unsupported badges and impossible lower bounds cannot silently disable the check", () => {
  assert.throws(() => checkTestCount("README without a badge", passed), /could not find/);
  for (const bound of ["0", "999999999999999999999999999999999999999"]) {
    assert.throws(() => checkTestCount(readme.replace("tests-10", `tests-${bound}`), passed), /positive safe integer/);
  }
  assert.throws(() => checkTestCount(readme.replace("tests-10", "tests-21"), passed), /suite has 20/);
});

test("the CLI returns failure for malformed JSON/reports and success only for a valid run", t => {
  const root = mkdtempSync(path.join(tmpdir(), "mechanica-test-count-"));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("mechanica-test-count-")) {
      throw new Error("Unexpected fixture cleanup path");
    }
    rmSync(root, { recursive: true, force: true });
  });
  const scripts = path.join(root, "web", "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "check-test-count.mjs");
  writeFileSync(script, readFileSync(new URL("./check-test-count.mjs", import.meta.url)));
  writeFileSync(path.join(root, "README.md"), readme);
  const reportPath = path.join(root, "web", "test-results.json");
  for (const input of ["{invalid", JSON.stringify({ numPassedTests: "unknown", numTotalTests: "unknown" }),
    JSON.stringify({ ...passed, success: false }), JSON.stringify(passed)]) {
    writeFileSync(reportPath, input);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    const valid = input === JSON.stringify(passed);
    assert.equal(result.status, valid ? 0 : 1, result.stderr);
    if (valid) assert.match(result.stdout, /OK/);
    else { assert.equal(result.stdout, ""); assert.ok(result.stderr.length > 0); }
  }
});
