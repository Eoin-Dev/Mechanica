# Testing and operations

Mechanica uses one Vitest verification suite for analytic physics, behavioral
contracts, rendering helpers, persistence, UI semantics, fuzz/stress sequences,
and long-run bounds. TypeScript compilation and the Vite production build are
separate required checks.

## Local commands

Run commands from `web/`:

```sh
npm install
npm run dev
npm test
npm run test:watch
npm run build
npm run preview
```

- `dev` starts Vite with hot reload.
- `test` runs the complete suite once.
- `test:watch` runs Vitest interactively.
- `build` first executes `tsc --noEmit`, then creates the static Vite bundle in
  `web/dist/`.
- `preview` serves that production output locally.

On PowerShell systems that block the `npm.ps1` shim, invoke the same commands as
`npm.cmd test`, `npm.cmd run build`, and so on.

Use `npm ci` rather than `npm install` in clean/CI environments. It installs the
exact dependency graph from `package-lock.json`.

## Required validation for changes

Before completing a source, configuration, schema, documentation, or dependency
change:

1. Run the focused tests while iterating.
2. Run the complete `npm test` suite.
3. Run `npm run build` to enforce strict TypeScript and production bundling.
4. Verify any affected interaction/render behavior manually in `npm run dev`
   when a headless test cannot exercise real pointer, focus, sizing, or Canvas
   behavior.
5. Check links in `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and `docs/*.md`
   when documentation paths change.
6. Update the current-behavior handbook page in the same change whenever its
   explanation, schema, workflow, invariant, or command would otherwise be
   stale.

Do not put a volatile exact test total into durable documentation. The root
README intentionally states a lower bound, and CI checks that bound against the
JSON results produced by the same run.

## Test configuration

`vite.config.ts` configures Vitest together with the build:

- CSS processing is enabled because the focus-ring suite imports the real
  stylesheet text; the default empty CSS stub would make cascade assertions
  meaningless.
- Test timeout is 30 seconds. Several files intentionally simulate every
  preset, long physical time spans, or dense worlds; they are verification and
  soak tests rather than only small unit tests.

`tsconfig.json` includes both `src` and `tests`, so the build's `tsc --noEmit`
also type-checks test code. Strict mode, unused locals/parameters, isolated
modules, and switch fallthrough checks are enabled.

Most physics/core tests run directly in Node. DOM-oriented tests install the
minimum jsdom or hand-written browser stubs they need. The suite does not need a
running Vite server.

## Test suite map

Every current test file is listed below. When adding a file, update this map
with the behavior it protects rather than an exact assertion count.

### Physics, constraints, and analytic behavior

| Test file | Protected behavior |
| --- | --- |
| [`analytic-physics.test.ts`](../web/tests/analytic-physics.test.ts) | Closed-form terminal velocity, orbital vis-viva/equal-area/angular-momentum/centre-of-mass behavior, inclined-plane friction, projectile motion, unequal-mass collision equations, and damped-oscillator response. |
| [`physics.test.ts`](../web/tests/physics.test.ts) | Broad engine verification: projectiles, collisions, orbits, pendulums, springs/stacks, rolling/friction, soft bodies under varied drag abuse, horizontal/vertical independence, gravity slingshot, Cyclone fields, sandbox behavior, and scene round trips. |
| [`gravity.test.ts`](../web/tests/gravity.test.ts) | Point versus solid-disc gravity, softening/interior force and energy agreement, anchor behavior, symmetry, and bit-identical packed attraction versus a reference implementation. |
| [`rigid-body-properties.test.ts`](../web/tests/rigid-body-properties.test.ts) | Disc inertia/energy, restitution, resting threshold, undo limits, held infinite mass, global damping, and constraint convergence properties. |
| [`no-rotation.test.ts`](../web/tests/no-rotation.test.ts) | Infinite rotational inertia semantics, friction without spin, and point-particle slope equilibrium. |
| [`rod-convergence.test.ts`](../web/tests/rod-convergence.test.ts) | Rod-chain length/energy accuracy, improvement with finer timesteps, badly resolved stability, and unilateral rope behavior. |
| [`string-one-sided.test.ts`](../web/tests/string-one-sided.test.ts) | Elastic strings never push, including when axial damping outweighs small extension. |
| [`collision-chain.test.ts`](../web/tests/collision-chain.test.ts) | Restitution propagation through touching chains without energy creation or inelastic smearing. |
| [`resting-contact.test.ts`](../web/tests/resting-contact.test.ts) | Stable/cheap settled piles and mutual-gravity clusters without jitter-driven refinement. |
| [`resting-friction.test.ts`](../web/tests/resting-friction.test.ts) | Static-friction anchors prevent creep, including contacts where either movable non-rotating body may be the pinned side. |
| [`contact-cache.test.ts`](../web/tests/contact-cache.test.ts) | Warm-start impulse identity across pair ordering changes and persistent contact behavior. |
| [`anchor.test.ts`](../web/tests/anchor.test.ts) | Anchor locking, gravity exclusion, naming/counting, link use, and serialization. |
| [`adaptive-quality.test.ts`](../web/tests/adaptive-quality.test.ts) | State-derived App subdivision quality and the boundaries that keep it independent of scheduling load. |
| [`slice-cost.test.ts`](../web/tests/slice-cost.test.ts) | Encounter slicing catches close motion while respecting the work budget for added/dense bodies. |
| [`perf-mode.test.ts`](../web/tests/perf-mode.test.ts) | Effective solver overrides without scene mutation, cheap stepping, stable projected springs over full control ranges, compliance behavior, strain/movement/speed bounds, mixed contacts, lifecycle changes, and neutral performance-mode UI styling. |

### Presets, determinism, stress, and long runs

| Test file | Protected behavior |
| --- | --- |
| [`presets.test.ts`](../web/tests/presets.test.ts) | Central solver affordability, shipped-scene survival/coherence, trampoline response, dense containment, penetration bounds, and contact iteration ceilings. |
| [`preset-invariants.test.ts`](../web/tests/preset-invariants.test.ts) | Catalogue uniqueness/completeness, finite sane structures, link identity, deterministic builders/steps, and exact save/load continuation. |
| [`preset-descriptions.test.ts`](../web/tests/preset-descriptions.test.ts) | Educational card claims agree with measured scene properties and every preset is covered by the description audit. |
| [`determinism.test.ts`](../web/tests/determinism.test.ts) | Bit-identical repeated runs and independence from performance scheduling for demanding scenes. |
| [`lifecycle-stress.test.ts`](../web/tests/lifecycle-stress.test.ts) | Continuous create/delete, integrator switching, repeated preset loads, violent reset, and sustained high-body-count consistency without cost drift. |
| [`operation-fuzz.test.ts`](../web/tests/operation-fuzz.test.ts) | Seeded random application operations, running interleavings, and gestures that outlive deleted/replaced targets. |
| [`soak.test.ts`](../web/tests/soak.test.ts) | Rewind/undo/history memory bounds, keyframe reclamation, long orbit/pendulum/contact stability, and bounded snapshot size. |

### Serialization, storage, history, and settings

| Test file | Protected behavior |
| --- | --- |
| [`scene-guards.test.ts`](../web/tests/scene-guards.test.ts) | Numeric/boolean/colour/name/ID guards, duplicate object-ID repair within each identity namespace, anchor normalization, settings and link ranges, malformed container shapes, field/driver defaults, missing/self link rejection, and stepping after damaged input. |
| [`robustness.test.ts`](../web/tests/robustness.test.ts) | Scene deserialization defaults, divergence reporting, object colours, closest-point geometry, and kinematic dragged-body wall sweeping. |
| [`scene-storage.test.ts`](../web/tests/scene-storage.test.ts) | Unicode name normalization, sanitized-key collisions, save/load/list, quota reporting, metadata, damaged payload handling, rollback/error semantics for scene mutations, rename behavior, orphan metadata, and deletion. |
| [`settings-guards.test.ts`](../web/tests/settings-guards.test.ts) | `sanitizeSettings` type filtering, enum/hex validation, collection limits, and layout/font clamping. |
| [`rewind.test.ts`](../web/tests/rewind.test.ts) | Digest-prefiltered structural keyframes versus exactly verified dynamic deltas, forced digest collisions, exact reconstruction, bounded heavy-scene history, changing structures, and frame-back behavior. |
| [`app-lifecycle.test.ts`](../web/tests/app-lifecycle.test.ts) | App construction, bounded/resumable time jumps, playback/history/reset, speed behavior, settings persistence, energy cache/baseline, and graph sampling. |

### Expressions and math editing

| Test file | Protected behavior |
| --- | --- |
| [`expr-semantics.test.ts`](../web/tests/expr-semantics.test.ts) | Python-like modulo/division/logic/comparisons, precedence/associativity, variables/constants/functions/arity, prototype sandbox, invalid/deep input behavior, closure purity, and compiler/typesetter table agreement. |
| [`mathfmt.test.ts`](../web/tests/mathfmt.test.ts) | Source/LaTeX/source round trips, MathLive-shaped input, invalid LaTeX rejection, typeset-subset gate, all shipped formula content, and precedence-preserving AST emission. |
| [`expr-roundtrip-fuzz.test.ts`](../web/tests/expr-roundtrip-fuzz.test.ts) | Seeded generated AST/source/LaTeX round trips preserve both structure and evaluated meaning across nested constructs. |

### Interaction, selection, camera, and trails

| Test file | Protected behavior |
| --- | --- |
| [`drag-velocity.test.ts`](../web/tests/drag-velocity.test.ts) | Primary drag preserves pre-grab velocity across paused/running/release/abort paths while temporary motion remains solver-visible and capped. |
| [`interaction-behaviour.test.ts`](../web/tests/interaction-behaviour.test.ts) | Click activation threshold, bounded drag energy, filtered box select, pick ordering/tolerance, distance-based trail sampling, plot restart/non-finite rejection, auto-fit guarantees, and deleted gesture targets. |
| [`selection-delete.test.ts`](../web/tests/selection-delete.test.ts) | Selection/hover/pending-state reconciliation after removal, linear batched deletion with cascades, and duplication of bodies/walls/links/drivers. |
| [`camera.test.ts`](../web/tests/camera.test.ts) | World/screen inverse transforms, panning, cursor-anchored zoom/clamps, visible bounds, and nice scale-bar formatting. |
| [`body-culling.test.ts`](../web/tests/body-culling.test.ts) | Scene-centred runaway classification, outward-motion requirement, orbit/furniture/held protections, and non-finite cleanup. |
| [`trail.test.ts`](../web/tests/trail.test.ts) | Ring-buffer order/capacity, timestamps, expiration, resize, serial continuity, and conservative bounds. |
| [`trail-render.test.ts`](../web/tests/trail-render.test.ts) | Visible/off-screen trail drawing, budgets, fading, stable decimation, endpoint/corner retention, and curve fidelity. |
| [`timeseries-render.test.ts`](../web/tests/timeseries-render.test.ts) | Visible-window selection, scrolling/zoom ranges, legends, axis labels, single points, hidden channels, autoscale, history retention, and redraw state. |

### DOM, shortcuts, accessibility, and responsive UI

| Test file | Protected behavior |
| --- | --- |
| [`accessibility.test.ts`](../web/tests/accessibility.test.ts) | Accessible control names, value semantics, exposed selected state, and refresh behavior that avoids redundant ARIA/DOM updates. |
| [`focus-ring.test.ts`](../web/tests/focus-ring.test.ts) | Stylesheet cascade retains keyboard focus visibility and the TypeScript/CSS phone breakpoints agree. |
| [`shortcuts.test.ts`](../web/tests/shortcuts.test.ts) | Focused-control ownership, modifier edits, tool keys, playback/view commands, modal/tour/Escape precedence, and unusual event targets. |
| [`splitter-drag.test.ts`](../web/tests/splitter-drag.test.ts) | Pointer capture, size direction, min/max clamps, commit behavior, and cancellation for inspector/dock resizing. |
| [`refresh-culling.test.ts`](../web/tests/refresh-culling.test.ts) | Scrolled controls skip refresh while hidden zero-rect controls remain eligible to reveal themselves. |
| [`inspector-rebuild.test.ts`](../web/tests/inspector-rebuild.test.ts) | Inspector structure keys detect type/identity/field/driver/tab changes without rebuilding for ordinary value changes. |
| [`tour.test.ts`](../web/tests/tour.test.ts) | Tour construction, first-visit behavior, progress/finish, settings persistence, and cleanup. |
| [`tour-spotlight.test.ts`](../web/tests/tour-spotlight.test.ts) | Multi-target spotlight tiling, clipping, rings, viewport placement, and responsive target geometry. |

## Verification philosophy

The suite combines several kinds of evidence:

- **Analytic comparisons** pin formulas against known mechanics rather than
  only checking that results are finite.
- **Invariants** verify identity, topology, one-sided constraints, non-
  penetration, bounded memory/work, and deterministic rebuilds.
- **Round trips** check serialized state and expression notation both before
  and after continued execution.
- **Stress/fuzz/soak tests** exercise lifecycle sequences and durations that
  reveal leaks, stale references, cost growth, or accumulated numerical error.
- **Rendering tests** use controlled Canvas contexts and observable drawing
  operations rather than image snapshots, keeping assertions focused on
  geometry/budgets/semantics.
- **DOM tests** isolate helpers/components so accessibility and event
  precedence remain testable without an end-to-end browser harness.

When fixing a defect, add the smallest test that pins the violated invariant in
the closest existing file. Add a new test file only when the behavior is a new
coherent area. Tests should name the mechanism and expected physical/UI
contract, not merely replay one bug report.

## Performance and determinism expectations

Performance work must preserve these boundaries:

- Physical results may depend on scene state and authored/user-selected solver
  modes, never measured frame duration or CPU speed.
- A slow frame may advance less simulated time, but each completed step uses
  the same state-derived resolution and force/constraint order.
- Presentation-only quality, such as trail vertex count or DOM refresh culling,
  may react to measured cost because it does not feed simulation state.
- Hot loops use reusable typed arrays/batches and geometric growth. New per-
  pair/per-spring/per-body allocations in repeated force/contact/render loops
  require measurement and justification.
- Histories, graph data, trail storage, caches, adaptive work, and contact work
  must remain bounded.
- Preset builders with pseudo-random layouts use a local seeded generator.

Relevant changes should run the determinism, slice-cost, lifecycle, operation-
fuzz, performance-mode, preset, and soak areas in addition to focused tests.

## Production build

`npm run build` executes:

1. `tsc --noEmit` using the strict project configuration; then
2. `vite build` targeting ES2022.

Vite uses `base: "./"`, making asset URLs relative so the same `dist/` works at
a GitHub Pages repository subpath, other static hosts, or local preview.

MathLive is intentionally a separate lazy chunk. Its size warning allowance is
raised only for that known chunk; the initial application does not import it
until a formula editor/guide typeset operation requests it. OpenDyslexic and
MathLive fonts are emitted as static assets. Build output is ignored by Git.

## Continuous deployment

`.github/workflows/deploy.yml` runs on pushes to `main` and manual dispatch.
The build job:

1. checks out the repository;
2. installs Node 22 with npm caching keyed by `web/package-lock.json`;
3. runs `npm ci` in `web`;
4. runs Vitest with human and JSON reporters;
5. runs `scripts/check-test-count.mjs` against the generated result so the
   README lower-bound badge cannot become false;
6. runs the production build; and
7. uploads `web/dist` as the Pages artifact.

The deploy job waits for build, uses the GitHub Pages environment and OIDC
permissions, and publishes through `actions/deploy-pages`. The workflow has a
single Pages concurrency group and cancels an older in-progress deployment
when a newer one starts.

Repository Pages settings must select GitHub Actions as the source. No server,
environment variables, database migration, or runtime secrets are required.

## Manual QA checklist

Use this proportionally to the change rather than as a mandatory ritual for
unrelated edits:

- Load representative orbit, contact/stack, pendulum, spring/soft-body, force-
  field, and dense-gas presets.
- Play, pause, step forward/back, reset, and enter a bounded future/past time.
- Create/edit/delete/duplicate every object type; undo/redo the result.
- Exercise primary drag, velocity drag, wall endpoints, link construction,
  panning, zooming, box selection, and optional solid dragging.
- Toggle accurate/performance modes and confirm authored solver controls return
  unchanged when performance mode is disabled.
- Open each graph, scroll/zoom it, toggle legend channels, and rewind.
- Save, rename, describe, download, import, load, and delete a scene.
- Edit a formula in text and typeset modes; verify invalid input remains
  recoverable and lazy loading fallback is usable.
- Keyboard-navigate controls and overlays; verify focus rings, Escape order,
  live status output, and no shortcut fires while typing.
- Check phone layout, touch wording/gestures where available, reduced motion,
  font scale, dyslexic font, light/dark themes, and custom accent.

Document any resulting behavior change in present tense in the appropriate
handbook page; do not append a release history to these pages.
