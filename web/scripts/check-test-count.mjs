/** Fail if the README's test-count badge has become a lie.
 *
 * The badge used to carry an exact number and had drifted fifty behind the
 * real suite, because nothing connected the two: an exact count in a README
 * is a claim about the PRESENT that only a human remembering to edit it
 * keeps true.
 *
 * So the badge states a LOWER BOUND, and this checks it. A bound only
 * becomes false if the suite shrinks past it, which is precisely when
 * someone should be told - and it needs no commit when a test is merely
 * added, which is the churn an exact figure would demand.
 *
 * Run by CI right after the suite, against the JSON report it emits.
 */
import { readFileSync } from "node:fs";

const README = new URL("../../README.md", import.meta.url);
const REPORT = new URL("../test-results.json", import.meta.url);

const badge = /badge\/tests-(\d+)%2B%20passing/.exec(readFileSync(README, "utf8"));
if (badge === null) {
  console.error(
    "README: could not find the tests badge, or it no longer states a lower\n" +
    "bound. Expected a shields.io badge of the form `tests-<N>+ passing`.\n" +
    "If the badge is meant to carry an exact number again, delete this check\n" +
    "rather than leaving it unable to verify anything.");
  process.exit(1);
}
const claimed = Number(badge[1]);

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch (err) {
  console.error(`Could not read the vitest JSON report at ${REPORT.pathname}\n` +
                `(${err.message}). CI runs the suite with\n` +
                "  --reporter=json --outputFile=test-results.json\n" +
                "before this script; run it the same way locally.");
  process.exit(1);
}

// numTotalTests counts every test the run collected; numPassedTests is the
// figure the badge actually claims, so a run with failures fails here too
// rather than quietly comparing against the total.
const passed = report.numPassedTests ?? 0;
const total = report.numTotalTests ?? 0;

if (passed < total) {
  console.error(`${total - passed} test(s) did not pass; the badge claims all do.`);
  process.exit(1);
}
if (passed < claimed) {
  console.error(
    `README badge claims ${claimed}+ passing tests, but the suite has ${passed}.\n` +
    "Either restore the missing tests or lower the badge's bound to match.");
  process.exit(1);
}

console.log(`README badge claims ${claimed}+ passing tests; the suite has ` +
            `${passed}. OK.`);
