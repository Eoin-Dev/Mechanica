# Mechanica — 2D Physics Lab

An interactive physics sandbox that runs entirely in the browser: build and
analyse mechanical systems — orbits, pendulums, oscillators, collisions,
gases, friction, chaos and soft bodies.

![typescript](https://img.shields.io/badge/TypeScript-strict-blue) ![deps](https://img.shields.io/badge/engine%20deps-none-green) ![tests](https://img.shields.io/badge/tests-600%2B%20passing-brightgreen)

The app lives in [`web/`](web/). No server, no accounts — everything
simulates locally in the visitor's browser.

## Run locally

Use Node.js 22.23.1 (the repository's `.node-version`); `package.json` accepts
maintained Node 22 releases from 22.22.2 up to, but not including, Node 23.

```
cd web
npm install
npm run dev        # dev server, live reload
```

## Test & build

```
npm test           # verification suite (physics, rendering, robustness)
npm run build      # production build into web/dist/
npx playwright install chromium  # one-time browser-test prerequisite
npm run test:e2e   # production-preview Chromium and axe checks
npm run benchmark:performance -- --quick  # comparative browser performance smoke matrix
```

The test badge is a lower bound enforced in CI by
`web/scripts/check-test-count.mjs`. Exact results belong in individual test
runs and completion reports rather than durable overview text.

## Deploy

Pushing to `main` automatically tests, builds and publishes the site via
GitHub Pages ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)).
One-time setup: repo **Settings → Pages → Source → "GitHub Actions"**.
The complete build, CI, Pages, and alternative-host instructions are in
[Testing and operations](docs/testing-and-operations.md).

## What's inside

- **Engine** (`web/src/engine/`) — circular rigid bodies with rotation,
  static capsule walls, rigid rods / one-sided ropes / damped springs,
  N-body gravity with softening, linear + quadratic drag, sinusoidal
  drivers and sandboxed user force fields.
- **Library** — dozens of ready-made, annotated simulations across eight
  categories (press `L`), plus saved scenes with rename, description, export,
  and import.
- **Analysis** — live energy / momentum / phase-space plots, velocity /
  acceleration / force vector overlays, motion trails, centre of mass,
  contact normals, an energy-drift readout in the status bar.
- **Editing** — direct manipulation with undo/redo, renameable objects, a
  type-filtered box select with bulk editing, grid snapping, property
  copy/paste, alignment tools, scene save/load (JSON).
- **Touch** — one finger drives the active tool; two fingers pinch-zoom and pan.

## Codebase documentation

The [codebase handbook](docs/README.md) is the detailed, current-state
implementation reference for maintainers and coding agents. It covers the
runtime architecture, physics solvers, interaction and rendering, UI,
persistence and scene JSON, the force-field language, every source module, the
verification suite, and deployment.

Behavior, architecture, interface, schema, workflow, build, and deployment
changes must update the relevant handbook page in the same change. The handbook
describes how the code works now; it is not a changelog. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the maintenance policy.

Repository documentation is intentionally centralized here, in the
contributor/agent instruction files, and in `docs/`; subsystem folders do not
carry duplicate README files.

The production distribution includes the upstream MathLive MIT and
OpenDyslexic SIL Open Font License notices in
[`web/public/THIRD_PARTY_NOTICES.txt`](web/public/THIRD_PARTY_NOTICES.txt).

## Controls (press F1 in-app for the full list)

| Key | Action |
| --- | --- |
| Space / `.` | Play / pause, step one frame |
| Ctrl+R / Ctrl+Z / Ctrl+Y | Reset, undo, redo |
| V H B A W R E S X | Tools: select, pan, body, anchor, wall, rod, rope, spring, eraser |
| F / C | Zoom to fit, follow selected body |
| Arrows | Nudge selected bodies |
| Ctrl+S | Save the scene |
| Scroll / right-drag | Zoom at cursor / pan |

Drag a body while the simulation is running and it follows the cursor exactly,
then resumes the motion it already had — moving something never throws it.
Hold it still and it stays pinned under the cursor while everything else
collides with it. Drag the green arrow tip of a selected body (or right-drag
it) to set its velocity exactly.

## Units

Everything is SI: metres, kilograms, seconds, newtons. Default gravity is
9.81 m/s² downward; the space presets use scaled units with G = 1.
