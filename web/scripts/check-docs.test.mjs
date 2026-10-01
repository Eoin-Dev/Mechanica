import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDocumentation } from "./check-docs.mjs";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "mechanica-doc-links-"));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("mechanica-doc-links-")) {
      throw new Error("Unexpected fixture cleanup path");
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, "docs"));
  for (const [file, text] of Object.entries({ "README.md": "", "CONTRIBUTING.md": "", ...files })) {
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("local links cover encoded filenames, parenthesized paths and duplicate heading collisions", t => {
  const root = fixture(t, {
    "README.md": "[file](docs/A%20file.md#experiment-2)\n[parentheses](docs/Note(copy).md#details)",
    "docs/A file.md": "# Experiment\n# Experiment-1\n# Experiment\n[first](#experiment)\n[second](#experiment-1)",
    "docs/Note(copy).md": "# Details",
  });
  const result = checkDocumentation(root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 4);
});

test("broken files, headings, encoding, references and escaping paths report source lines", t => {
  const root = fixture(t, {
    "README.md": "[file](missing.md)\n[heading](docs/page.md#absent)\n[bad](%zz)\n[label][unknown]\n[outside](../outside.md)",
    "docs/page.md": "# Present",
  });
  const { failures } = checkDocumentation(root);
  assert.equal(failures.length, 5);
  for (let line = 1; line <= 5; line++) assert.ok(failures.some(failure => failure.startsWith(`README.md:${line}:`)));
});

test("fences require matching length, and code examples and comments are skipped", t => {
  const root = fixture(t, {
    "README.md": "````md\n[example](missing.md)\n```\n[still code](missing.md)\n````\n" +
      "~~~\n[tilde example](missing.md)\n~~~\n`[inline example](missing.md)`\n" +
      "<!-- [comment](missing.md) -->\n    [indented example](missing.md)\n[real](docs/page.md)",
    "docs/page.md": "# Present",
  });
  const result = checkDocumentation(root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});

test("reference definitions and full or collapsed references use normalized labels", t => {
  const root = fixture(t, {
    "README.md": "[text][ A   LABEL ]\n[a label][]\n[a label]\n\n[a label]: docs/page.md#present",
    "docs/page.md": "# Present",
  });
  assert.deepEqual(checkDocumentation(root).failures, []);
});

test("case mistakes fail on both case-sensitive and case-insensitive hosts", t => {
  const root = fixture(t, {
    "README.md": "[wrong](docs/Page.md)",
    "docs/page.md": "# Present",
  });
  assert.equal(checkDocumentation(root).failures.length, 1);
});

test("Unicode, inline heading links and explicit HTML anchors stay addressable", t => {
  const root = fixture(t, {
    "README.md": "[unicode](docs/page.md#énergie--forces)\n[inline](docs/page.md#api)\n[html](docs/page.md#custom)",
    "docs/page.md": '# Énergie &amp; forces\n# [API](https://example.com)\n<a id="custom"></a>',
  });
  assert.deepEqual(checkDocumentation(root).failures, []);
});
