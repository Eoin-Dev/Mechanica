/** Check that the CI test report meets the README badge's lower bound. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const README = new URL("../../README.md", import.meta.url);
const REPORT = new URL("../test-results.json", import.meta.url);

/** Reject malformed/incomplete reports before trusting the passing count. */
export function checkTestCount(readme, report) {
  const badge = /badge\/tests-(\d+)%2B%20passing/.exec(readme);
  if (badge === null) throw new Error(
    "README: could not find the tests badge, or it no longer states a lower\n" +
    "bound. Expected a shields.io badge of the form `tests-<N>+ passing`.\n" +
    "If the badge is meant to carry an exact number again, delete this check\n" +
    "rather than leaving it unable to verify anything.");
  const claimed = Number(badge[1]);
  if (!Number.isSafeInteger(claimed) || claimed <= 0) {
    throw new Error("README test-count bound must be a positive safe integer.");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Vitest report must be an object.");
  }
  if (report.success !== true) throw new Error("Vitest report does not confirm a successful run.");
  for (const field of ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0) {
      throw new Error(`Vitest report ${field} must be a non-negative safe integer.`);
    }
  }
  const passed = report.numPassedTests;
  const total = report.numTotalTests;
  if (passed !== total || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw new Error("Vitest report contains failed, skipped, pending or inconsistent test counts; the badge claims all pass.");
  }
  // A suite can fail before collecting an individual test. Do not accept
  // internally contradictory successful reports with a suite/runtime failure.
  for (const field of ["numFailedTestSuites", "numRuntimeErrorTestSuites"]) {
    if (Object.hasOwn(report, field) && report[field] !== 0) {
      throw new Error(`Vitest report contains invalid or nonzero ${field}.`);
    }
  }
  if (passed < claimed) throw new Error(
    `README badge claims ${claimed}+ passing tests, but the suite has ${passed}.\n` +
    "Either restore the missing tests or lower the badge's bound to match.");
  return `README badge claims ${claimed}+ passing tests; the suite has ${passed}. OK.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const readme = readFileSync(README, "utf8");
    let report;
    try { report = JSON.parse(readFileSync(REPORT, "utf8")); }
    catch (error) {
      throw new Error(`Could not read the Vitest JSON report at ${fileURLToPath(REPORT)}\n` +
        `(${error.message}). Run the suite with\n` +
        "  --reporter=json --outputFile=test-results.json\n" +
        "before this check.");
    }
    console.log(checkTestCount(readme, report));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
