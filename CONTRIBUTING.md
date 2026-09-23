# Contributing

Read the [handbook index](docs/README.md) and the pages for the area you plan
to change. Keep changes focused and preserve unrelated work already in the
checkout.

## Documentation

Update the relevant handbook page in the same change whenever behavior,
architecture, interfaces, persisted data, workflows, invariants, build,
testing, or deployment changes. The [ownership table](docs/source-reference.md#documentation-ownership)
maps source areas to pages.

Describe the current implementation. Rewrite or remove stale explanations;
keep change history in commits. A bug fix needs no documentation edit if it
restores behavior the handbook already describes accurately. Avoid exact
totals that drift, such as test counts, unless an automated check maintains
them. Update the index and README links when pages move or are added.

Before finishing, compare the affected pages against the code and verify
their links, identifiers, defaults, schemas, commands, and diagrams.

## Implementation constraints

The physics engine must remain usable headlessly. Keep browser and UI
dependencies out of web/src/engine. Normal-mode physics must not depend on
measured frame time; see [performance and determinism expectations](docs/testing-and-operations.md#performance-and-determinism-expectations)
for the separate Performance-mode rules.

## Validation

Run focused tests for the affected area, then the full suite and build:

```sh
cd web
npm test
npm run build
```

Use npm.cmd on PowerShell if the script shim is disabled. Run browser tests
for interaction or presentation changes. See [Testing and operations](docs/testing-and-operations.md)
for browser setup, additional checks, and deployment requirements.

## Commit messages

Use an imperative subject without a trailing period. Name the behavior or
component affected. In the body, explain the problem, the resulting behavior,
and relevant validation. Use separate sections when a change spans several
areas; include identifiers and measurements when they help a reviewer.

Quote UI labels exactly. Report test results from the actual run and describe
what the tests verify. Omit promotional language and unsupported claims.
