# Mechanica — 2D Physics Lab

An interactive physics sandbox that runs entirely in the browser: build and
analyse mechanical systems — orbits, pendulums, oscillators, collisions,
gases, friction, chaos and soft bodies.

![typescript](https://img.shields.io/badge/TypeScript-strict-blue) ![deps](https://img.shields.io/badge/runtime%20deps-none-green) ![tests](https://img.shields.io/badge/physics%20tests-42-brightgreen)

The app lives in [`web/`](web/). No server, no accounts — everything
simulates locally in the visitor's browser.

## Run locally

```
cd web
npm install
npm run dev        # dev server, live reload
```

## Test & build

```
npm test           # physics verification suite (42 analytic checks)
npm run build      # production build into web/dist/
```

## Deploy

Pushing to `main` automatically tests, builds and publishes the site via
GitHub Pages ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)).
One-time setup: repo **Settings → Pages → Source → "GitHub Actions"**.
Details and alternative hosts in [web/README.md](web/README.md).

## What's inside

- **Engine** (`web/src/engine/`) — circular rigid bodies with rotation,
  static capsule walls, rigid rods / one-sided ropes / damped springs,
  N-body gravity with softening, linear + quadratic drag, sinusoidal
  drivers and sandboxed user force fields.
  - Integrators: Velocity Verlet (default, symplectic), Symplectic Euler, RK4.
  - Rods and ropes are solved in two phases: the analytic constraint force
    (tension) is computed at the acceleration level with warm-started
    Gauss-Seidel *before* integrating, then an XPBD position pass removes the
    tiny residual drift. This keeps pendulums and chains energy-conserving
    (a double pendulum drifts well under 0.1% per minute).
  - Contacts: spatial-hash broadphase, then iterated sequential impulses with
    accumulated-impulse clamping and warm starting (the Box2D scheme),
    restitution as a pre-solve velocity bias, Coulomb friction applied at the
    contact point (so rolling emerges from torque), and split-impulse
    positional correction that cannot inject energy. Stacks come to rest.
  - Any body whose state blows up numerically is frozen and reported instead
    of crashing the app.
- **Library** — 47 ready-made, annotated simulations across eight categories
  (press `L`), plus saved scenes with rename/describe/export/import.
- **Analysis** — live energy / momentum / phase-space plots, velocity /
  acceleration / force vector overlays, motion trails, centre of mass,
  contact normals, an energy-drift readout in the status bar.
- **Editing** — direct manipulation with undo/redo, renameable objects, a
  type-filtered box select with bulk editing, grid snapping, property
  copy/paste, alignment tools, scene save/load (JSON).
- **Touch** — one finger drives the active tool; two fingers pinch-zoom and pan.

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

Drag a body while the simulation is running to throw it; hold it still and
it stays pinned under the cursor while everything else collides with it.
Drag the green arrow tip of a selected body to set its velocity exactly.

## Units

Everything is SI: metres, kilograms, seconds, newtons. Default gravity is
9.81 m/s² downward; the space presets use scaled units with G = 1.
