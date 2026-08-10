# Mechanica codebase handbook

This handbook is the detailed implementation reference for Mechanica, the
browser-based 2D mechanics laboratory in [`web/`](../web/). It is written for
both maintainers and coding agents. The source code remains authoritative; the
handbook explains how the source is organized, how state moves through it, and
which invariants must remain true when it is changed.

> **Keep this handbook current.** Any change to runtime behavior,
> architecture, interfaces, persisted data, user workflows, build or
> deployment behavior must update the relevant page in the same change. The
> pages describe how the current code works, not how it used to work: rewrite
> or remove stale text instead of appending change history. A bug fix needs a
> documentation edit only when it changes documented behavior or invalidates
> an existing explanation, contract, invariant, schema, or workflow.

## Handbook map

| Page | What it explains |
| --- | --- |
| [Architecture and runtime](architecture.md) | Bootstrap, dependency direction, state ownership, the animation loop, fixed-timestep scheduling, world replacement, and the main end-to-end flows. |
| [Physics engine](physics-engine.md) | Physical data, forces, integrators, adaptive slicing, rods, ropes, springs, contacts, performance mode, diagnostics, and numerical safeguards. |
| [Application and UI](application-ui.md) | `App`, canvas tools, input gestures, editing, rendering, camera behavior, trails, graphs, panels, overlays, themes, responsive behavior, and accessibility. |
| [Data, formulas, and scenes](data-formulas-scenes.md) | Scene JSON, validation, settings, local storage, snapshots, undo/rewind, import/export, the force-field language, MathLive conversion, and presets. |
| [Source reference](source-reference.md) | Every file under `web/src`, its responsibilities, important exports, dependencies, callers, and invariants, plus the important project entry points. |
| [Testing and operations](testing-and-operations.md) | Test-area map, local commands, TypeScript/Vite settings, performance and determinism expectations, CI, and GitHub Pages deployment. |

Suggested reading paths:

- New maintainers: this page, then [architecture](architecture.md), then the
  subsystem page for the work at hand.
- Physics work: [physics engine](physics-engine.md), followed by the engine
  rows in the [source reference](source-reference.md).
- UI or interaction work: [application and UI](application-ui.md), followed by
  the UI and interaction rows in the source reference.
- Scene compatibility or formula work: [data, formulas, and
  scenes](data-formulas-scenes.md).
- Release or validation work: [testing and
  operations](testing-and-operations.md).

Documentation has four deliberate entry points rather than subsystem-level
README files:

- the root [`README.md`](../README.md) is the user-facing overview and quick
  start;
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) defines contribution and commit
  conventions;
- [`AGENTS.md`](../AGENTS.md) gives coding agents repository-wide rules; and
- this directory owns detailed implementation and operational behavior.

Put new detail in the handbook page that owns the subject. Add another page
only when the material has a distinct maintenance owner and would make an
existing page materially harder to navigate.

## Repository at a glance

Mechanica is a static, client-only application:

- TypeScript is compiled in strict mode and bundled by Vite.
- The UI uses browser DOM APIs and Canvas 2D directly; there is no UI
  framework.
- The physics engine is dependency-free and can run headlessly under Node in
  the test suite.
- MathLive is the only runtime package. It is dynamically imported when a
  typeset formula editor or formula rendering is first requested.
- Scenes and preferences stay in the browser unless a scene is explicitly
  downloaded. There is no server, account system, database, or telemetry
  client.
- The production build is static and is deployed to GitHub Pages by the
  repository workflow.

```text
AI Mechanics Simulator/
├── README.md                 project overview and user-facing quick start
├── CONTRIBUTING.md           documentation and commit conventions
├── AGENTS.md                 repository instructions for coding agents
├── docs/                     this implementation handbook
├── .github/workflows/        build, verification, and Pages deployment
└── web/
    ├── index.html            fixed application shell
    ├── package.json          scripts and dependencies
    ├── vite.config.ts        build and Vitest configuration
    ├── src/
    │   ├── main.ts           browser bootstrap and global event wiring
    │   ├── app.ts            application state and frame orchestration
    │   ├── core/             vectors, guards, expressions, math notation
    │   ├── engine/           world model and solvers
    │   ├── interact/         canvas tools and pointer gestures
    │   ├── render/           camera, world drawing, and trails
    │   ├── scene/            presets, snapshots, history, persistence
    │   ├── ui/               controls, panels, overlays, plots, and tour
    │   ├── fonts/            bundled OpenDyslexic font files
    │   └── style.css         layout, themes, responsive and focus styling
    └── tests/                headless verification suite
```

## Core mental model

The application has five cooperating layers:

1. `main.ts` obtains the fixed DOM nodes, creates one `App`, constructs panels
   and overlays around it, wires document/window events, loads the first
   preset, and starts animation.
2. `App` owns the live `World`, camera, view choices, playback scheduler,
   selection, histories, trails, plots, and persisted browser preferences.
3. `CanvasController` translates pointer gestures into edits, direct
   manipulation, camera movement, or selection changes.
4. `World.step()` advances only simulation state. It knows nothing about the
   DOM, panels, canvas size, or browser storage.
5. Render and UI modules read current state. Canvas drawing is immediate-mode;
   DOM controls expose refresh callbacks that are polled by the frame loop.

The important dependency rule is that the engine does not import application,
rendering, interaction, scene, or UI modules. That keeps physical behavior
headless and testable.

## Glossary

| Term | Meaning in this repository |
| --- | --- |
| Body | A circular rigid body with translation and optional rotation. A locked or held body presents zero inverse mass to solvers. |
| Anchor | A locked body used only as a link attachment. It does not produce or receive mutual gravity and is omitted from ordinary body counts. |
| Wall | A static capsule: a line segment expanded by half its thickness. |
| Link | Either a `DistanceLink` (rod or inelastic string) or a `SpringLink` (spring or elastic string). |
| Rod | A bilateral distance constraint that resists both extension and compression. |
| Rope / inelastic string | A `DistanceLink` with `isRope`; it enforces a maximum distance but is slack below it. |
| Elastic string | A `SpringLink` with `tensionOnly`; it pulls while stretched and does nothing while slack. |
| Substep | One of the configured slices inside a call to `World.step(dt)`. Constraint and contact resolution run for each substep. |
| Adaptive resolution | Extra `World.step` calls selected by `App` from simulation state before a base quantum is advanced. |
| Encounter slice | Finer integration performed inside a world substep for mutual-gravity close encounters. |
| Performance mode | A browser preference with four load-selected approximation levels. It projects springs, caps collision/constraint work, may aggregate gravity and sleep bodies, and progressively reduces rendering fidelity. Neither the preference level nor sleep state is serialized into scenes. |
| Warm start | Reusing the previous substep's rod tension or contact impulses as the next solve's initial estimate. |
| Split impulse | Removing penetration by changing position without changing velocity, so the correction does not add kinetic energy. |
| Structural state | Serialized world properties other than body position, velocity, angle, spin, and clock; used to decide when rewind needs a full keyframe. |
| Panel | A DOM component with `refresh()`, polled at 30 Hz while playing and 20 Hz while paused. |
| Selectable | A body, wall, or link. Selection itself belongs to `App`, not to engine objects. |

## Documentation contract

When changing the project:

1. Identify the affected handbook page using the map above or the ownership
   table in [source reference](source-reference.md#documentation-ownership).
2. Update descriptions, diagrams, schemas, tables, defaults, and workflows so
   they match the resulting code.
3. Remove obsolete descriptions. Do not preserve them as migration notes or
   append statements such as “this was changed to.” Git history is the change
   record; this handbook is the present-tense reference.
4. Keep implementation names when they help a reader find the code, but
   explain the behavior and invariant rather than transcribing functions line
   by line.
5. Do not hard-code totals that naturally drift, such as the exact number of
   tests, unless a check keeps the claim true. Exact results belong in the
   verification output or commit message.
6. Run the checks described in [testing and
   operations](testing-and-operations.md) and verify all Markdown links.

The same policy is repeated in [`CONTRIBUTING.md`](../CONTRIBUTING.md) for
human contributors and [`AGENTS.md`](../AGENTS.md) for coding agents so it is
encountered before a change is completed.
