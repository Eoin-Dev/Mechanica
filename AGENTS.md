# Repository instructions for coding agents

These instructions apply to the entire repository.

## Keep implementation documentation current

The authoritative implementation handbook begins at
[`docs/README.md`](docs/README.md). At the start of every code or configuration
task, read the index and the handbook pages assigned to the affected area; do
not rely on a remembered description. Before completing the task, compare the
resulting code and configuration with those pages again.

Update documentation in the same change whenever runtime behavior,
architecture, interfaces, persisted data, user workflows, invariants, build,
testing, or deployment behavior changes. This applies equally to added,
removed, renamed, and reorganized behavior.

The handbook describes only how the current code works:

- Rewrite or delete stale explanations instead of appending history.
- Describe new behavior directly in its final current form.
- Do not add “previously,” “now,” “was changed,” migration diaries, or release
  notes to the implementation pages. Git history records changes.
- A bug fix needs no documentation edit when it only restores behavior already
  described accurately. Update the handbook when the fix changes documented
  behavior or invalidates an explanation, contract, invariant, schema, or
  workflow.
- Avoid exact totals that drift naturally, such as the current number of tests,
  unless an automated check keeps the claim true.

Use the documentation ownership table in
[`docs/source-reference.md`](docs/source-reference.md#documentation-ownership):

- engine work: `docs/physics-engine.md`;
- app, lifecycle, scheduling, and dependency flow: `docs/architecture.md`;
- rendering, interaction, panels, overlays, accessibility, and responsive UI:
  `docs/application-ui.md`;
- scene JSON, settings, storage, formulas, and presets:
  `docs/data-formulas-scenes.md`;
- modules/files/interfaces: `docs/source-reference.md`;
- tests, commands, build, CI, and deployment:
  `docs/testing-and-operations.md`.

Update the handbook index and README links if files move or pages are added.

## Validation

The application lives in `web/`. For completed changes, run the relevant
focused tests followed by:

```sh
cd web
npm test
npm run build
```

On PowerShell where the npm script shim is disabled, use `npm.cmd` for the same
commands. Verify Markdown links and every documented identifier/default/schema
against source when documentation changes.

The physics engine must remain usable headlessly. Do not introduce browser/UI
dependencies into `web/src/engine` or make physical results depend on measured
frame time. Preserve user changes already present in the worktree and keep
unrelated edits out of the task.
