# Mechanica — 2D Physics Lab

An interactive physics sandbox for building and analysing mechanical systems:
orbits, pendulums, oscillators, collisions, gases, friction and chaos.

![requires](https://img.shields.io/badge/python-3.10%2B-blue) ![deps](https://img.shields.io/badge/deps-pygame-green)

## Run

```
pip install pygame
python -m mechanica
```

Verify the physics engine against analytic results (headless, no window):

```
python -m mechanica.tests_physics
```

## What's inside

- **Engine** (`mechanica/engine/`) — circular rigid bodies with rotation,
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
- **Library** — 29 ready-made, annotated simulations across six categories
  (press `L`).
- **Analysis** — live energy / momentum / phase-space plots, velocity /
  acceleration / force vector overlays, motion trails, centre of mass,
  contact normals, an energy-drift readout in the status bar.
- **Editing** — direct manipulation with undo/redo, box select, grid
  snapping, property copy/paste, alignment tools, scene save/load (JSON).

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

Drag a body while the simulation is running to throw it. Drag the green
arrow tip of a selected body to set its velocity exactly.

## Units

Everything is SI: metres, kilograms, seconds, newtons. Default gravity is
9.81 m/s² downward; the space presets use scaled units with G = 1.
