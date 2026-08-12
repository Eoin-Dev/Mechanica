# Testing and operations

Mechanica uses a headless Vitest verification suite for analytic physics,
behavioral contracts, rendering helpers, persistence, UI semantics,
fuzz/stress sequences, and long-run bounds. A pinned Chromium Playwright suite
uses axe-core and real browser layout, focus, input, and Canvas behavior.
TypeScript compilation and the Vite production build are separate required
checks.

Use Node.js 22.23.1 from [`.node-version`](../.node-version). The package engine
accepts Node `>=22.22.2 <23`. Browser acceptance also requires the pinned
Playwright Chromium binary; install it once after installing packages.

## Local commands

Run commands from `web/`:

```sh
npm install
npx playwright install chromium
npm run dev
npm test
npm run test:watch
npm run build
npm run test:e2e
npm run benchmark:performance -- --quick
npm run preview
npm audit
```

- `dev` starts Vite with hot reload.
- `test` runs the complete suite once.
- `test:watch` runs Vitest interactively.
- `build` first executes `tsc --noEmit`, then creates the static Vite bundle in
  `web/dist/`.
- `test:e2e` starts a production preview of the existing `web/dist/`, runs the
  serial Chromium/axe acceptance suite, then closes the preview. Run `build`
  first.
- `benchmark:performance` starts a development server and bundled headless
  Chromium, then prints frame-time, physics-time, render-time, contact, body,
  canvas, and active-profile measurements. The full matrix covers DPR 1/2,
  Normal/maximum mode, empty/simple/ramp/stack scenes, gases from 50 to 2,000,
  a spring lattice, rope, and mutual gravity. `--quick` runs empty, two-body,
  and 200-particle gas smoke comparisons at DPR 1. Benchmark values describe
  the current machine and are intentionally not a flaky CI threshold.
- `preview` serves that production output locally.
- `audit` asks the configured npm registry for known dependency
  vulnerabilities. Keep certificate validation enabled; fix the local trust
  store or use an organization-provided CA when registry TLS cannot be
  validated.

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
4. Run `npm run test:e2e` after a current build for application, interaction,
   accessibility, responsive, dependency, or delivery changes.
5. Verify affected behavior manually when automated browser tests cannot
   exercise browser-chrome zoom overrides, assistive technology, or touch
   hardware.
6. Check links in `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and `docs/*.md`
   when documentation paths change.
7. Update the current-behavior handbook page in the same change whenever its
   explanation, schema, workflow, invariant, or command would otherwise be
   stale.

Do not put a volatile exact test total into durable documentation. The root
README intentionally states a lower bound, and CI checks that bound against the
JSON results produced by the same run.

## Test configuration

`vite.config.ts` configures Vitest together with the build:

- `tests/**/*.test.ts` is the explicit Vitest include, keeping Playwright's
  `e2e/` tree under its own runner.
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

`playwright.config.ts` runs only Chromium, serially, because every page owns a
continuous animation loop. It records a trace on the first CI retry and a
screenshot on failure. `scripts/run-e2e.mjs` starts Vite preview through its
API, invokes the pinned Playwright CLI, forwards termination signals and closes
the server reliably. CI installs Chromium with its Linux system dependencies;
local installations normally use `npx playwright install chromium`.

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
| [`perf-mode.test.ts`](../web/tests/perf-mode.test.ts) | Four effective solver profiles without scene mutation, approximate large-cloud gravity, deterministic bounded energy, sleep/wake, maximum friction/spin omission, stable projected springs over full control ranges, compliance behavior, strain/movement/speed bounds, mixed contacts, lifecycle changes, and neutral UI styling. |
| [`engine-safety.test.ts`](../web/tests/engine-safety.test.ts) | Fixed-support friction chains and common translation, held-support exclusion, final performance-spring displacement bounds, spring/string endpoint collision, strict timestep contracts, numeric import/runtime caps, and velocity-dependent Verlet convergence/conservative arithmetic. |

### Presets, determinism, stress, and long runs

| Test file | Protected behavior |
| --- | --- |
| [`presets.test.ts`](../web/tests/presets.test.ts) | Central solver affordability, shipped-scene survival/coherence, dynamic Sun/Earth/Moon barycentre and hierarchy bounds, trampoline response, dense containment, penetration bounds, and contact iteration ceilings. |
| [`preset-invariants.test.ts`](../web/tests/preset-invariants.test.ts) | Catalogue uniqueness/completeness, finite sane structures, link identity, deterministic builders/steps, and exact save/load continuation. |
| [`preset-descriptions.test.ts`](../web/tests/preset-descriptions.test.ts) | Educational card claims agree with measured scene properties, including Friction ramp non-rotation/spacing and Trampoline anchor/suspension/ball geometry, and every preset is covered by the description audit. |
| [`determinism.test.ts`](../web/tests/determinism.test.ts) | Bit-identical repeated runs and independence from performance scheduling for demanding scenes. |
| [`lifecycle-stress.test.ts`](../web/tests/lifecycle-stress.test.ts) | Continuous create/delete, integrator switching, repeated preset loads, violent reset, and sustained high-body-count consistency without cost drift. |
| [`operation-fuzz.test.ts`](../web/tests/operation-fuzz.test.ts) | Seeded random application operations, running interleavings, and gestures that outlive deleted/replaced targets. |
| [`soak.test.ts`](../web/tests/soak.test.ts) | Rewind/undo/history memory bounds, keyframe reclamation, long orbit/pendulum/contact stability, and bounded snapshot size. |

### Serialization, storage, history, and settings

| Test file | Protected behavior |
| --- | --- |
| [`scene-guards.test.ts`](../web/tests/scene-guards.test.ts) | Numeric/boolean/colour/name/ID guards and limits, collection-resource caps, duplicate object-ID repair within each identity namespace, anchor normalization, settings and link ranges, malformed container shapes, field/driver defaults, missing/self link rejection, and stepping after damaged input. |
| [`robustness.test.ts`](../web/tests/robustness.test.ts) | Scene deserialization defaults, divergence reporting, object colours, closest-point geometry, and kinematic dragged-body wall sweeping. |
| [`scene-storage.test.ts`](../web/tests/scene-storage.test.ts) | Unicode name normalization, millisecond/suffix save collisions, save/load/list, discriminated cancellation/invalid/oversize/storage outcomes, upload and collection limits, quota reporting, metadata, damaged payload handling, rollback/error semantics, rename behavior, orphan metadata, and deletion. |
| [`settings-guards.test.ts`](../web/tests/settings-guards.test.ts) | `sanitizeSettings` type filtering, enum/hex validation, collection limits, and layout/font clamping. |
| [`rewind.test.ts`](../web/tests/rewind.test.ts) | Digest-prefiltered structural keyframes versus exactly verified dynamic deltas, forced digest collisions, exact reconstruction including evolved angles, 48 MB/entry bounds and oversize rejection, changing structures, key reclamation, and frame-back behavior. |
| [`app-lifecycle.test.ts`](../web/tests/app-lifecycle.test.ts) | Exact pre-edit transactions after simulation, undoable replacement routes and atomic failures, history byte limits, first-failure physics batching, strict time jumps, phase/trail rewind cleanup, playback/reset, persisted-settings guards, Performance-mode trail suppression/restoration, energy baselines, live-state energy-cache invalidation, energy/drift/momentum/phase graph sampling, and paused-loop energy behavior. |

### Expressions and math editing

| Test file | Protected behavior |
| --- | --- |
| [`expr-semantics.test.ts`](../web/tests/expr-semantics.test.ts) | Python-like modulo/division/logic/comparisons, precedence/associativity, variables/constants/functions/arity, prototype sandbox, invalid/deep input behavior, closure purity, and compiler/typesetter table agreement. |
| [`mathfmt.test.ts`](../web/tests/mathfmt.test.ts) | Source/LaTeX/source round trips, MathLive-shaped input, invalid LaTeX rejection, typeset-subset gate, all shipped formula content, and precedence-preserving AST emission. |
| [`expr-roundtrip-fuzz.test.ts`](../web/tests/expr-roundtrip-fuzz.test.ts) | Seeded generated AST/source/LaTeX round trips preserve both structure and evaluated meaning across nested constructs. |
| [`expression-limits.test.ts`](../web/tests/expression-limits.test.ts) | Exact source/token/node/depth/argument budgets, no truncation, `ExprError` normalization, formatter/compiler agreement, and atomic two-axis field installation without stale closures. |

### Interaction, selection, camera, and trails

| Test file | Protected behavior |
| --- | --- |
| [`drag-velocity.test.ts`](../web/tests/drag-velocity.test.ts) | Primary drag preserves pre-grab velocity across paused/running/release/abort paths while temporary motion remains solver-visible; its one-fifth hand response and pointer-time rod correction avoid substep-amplified anchor lunges, while linked response is chase-capped only in Performance mode. |
| [`interaction-behaviour.test.ts`](../web/tests/interaction-behaviour.test.ts) | Click activation threshold, bounded drag energy, continuously maintained parked velocity aims, filtered box select, pick ordering/tolerance, distance-based trail sampling, plot restart/non-finite rejection, auto-fit guarantees, and deleted gesture targets. |
| [`selection-delete.test.ts`](../web/tests/selection-delete.test.ts) | Selection/hover/pending-state reconciliation after removal, linear batched deletion with cascades, and duplication of bodies/walls/links/drivers. |
| [`camera.test.ts`](../web/tests/camera.test.ts) | World/screen inverse transforms, panning, cursor-anchored zoom/clamps, visible bounds, and nice scale-bar formatting. |
| [`body-culling.test.ts`](../web/tests/body-culling.test.ts) | Scene-centred runaway classification, outward-motion requirement, orbit/furniture/held protections, and non-finite cleanup. |
| [`trail.test.ts`](../web/tests/trail.test.ts) | Ring-buffer order/capacity, timestamps, expiration, resize, serial continuity, and conservative bounds. |
| [`trail-render.test.ts`](../web/tests/trail-render.test.ts) | Narrow non-`Path2D` full/coarse world-grid, spatial-debug and disjoint-body strokes, square-root-free link slack classification, Performance-mode trail omission, visible/off-screen Normal-mode trail drawing, bounded dense paths, budgets, fading, stable decimation, endpoint/corner retention, and curve fidelity. |
| [`timeseries-render.test.ts`](../web/tests/timeseries-render.test.ts) | Visible-window selection, scrolling/zoom ranges, responsive axes, single points, explicit channel state, exact-sample and rolling-stat queries, independently keyed autoscale, history retention, redraw state, and easing termination for non-plottable data. |
| [`render-invalidation.test.ts`](../web/tests/render-invalidation.test.ts) | Opaque 2D context creation, idempotent and Performance-DPR backing resize, retained unchanged/empty-playback frames, paused 20 Hz scheduling with immediate invalidation wake, adaptive maximum level, overloaded alternate presentation, render-cost decay, and every redraw route. |

### DOM, shortcuts, accessibility, and responsive UI

| Test file | Protected behavior |
| --- | --- |
| [`accessibility.test.ts`](../web/tests/accessibility.test.ts) | Accessible control names, shortcut-name isolation, play state, value/selected semantics, zero-preserving and softened-log slider mappings, tab helpers, and refresh behavior that avoids redundant ARIA/DOM updates. |
| [`focus-ring.test.ts`](../web/tests/focus-ring.test.ts) | Stylesheet cascade retains keyboard focus visibility and the TypeScript/CSS phone breakpoints agree. |
| [`shortcuts.test.ts`](../web/tests/shortcuts.test.ts) | Focused-control ownership, modifier edits, tool keys, playback/view commands, modal/tour/Escape precedence, and unusual event targets. |
| [`splitter-drag.test.ts`](../web/tests/splitter-drag.test.ts) | Pointer capture plus keyboard 10/32-pixel steps and Home/End limits, separator orientation/value metadata and reveal-time resynchronization, size direction, min/max clamps, commit behavior, and cancellation for inspector/dock resizing. |
| [`refresh-culling.test.ts`](../web/tests/refresh-culling.test.ts) | Scrolled controls skip refresh while hidden zero-rect controls remain eligible to reveal themselves. |
| [`inspector-rebuild.test.ts`](../web/tests/inspector-rebuild.test.ts) | Inspector structure keys and stable refreshes, body counts independent from cascading link deletion, semantic tabs/reopen/splitter metadata, desktop visibility persistence, accessible driver removal, Performance-mode solver/trail disabled states and banner copy, and exact delayed-input transactions after intervening simulation. |
| [`tour.test.ts`](../web/tests/tour.test.ts) | Tour construction, first-visit behavior, progress/finish, settings persistence, and cleanup. |
| [`tour-spotlight.test.ts`](../web/tests/tour-spotlight.test.ts) | Multi-target spotlight tiling, clipping, rings, viewport placement, and responsive target geometry. |
| [`panel-accessibility.test.ts`](../web/tests/panel-accessibility.test.ts) | Toolbar/graph icon names, play state labels, unchanged-clock write suppression, separated grammatical status counts with internal trail/subdivision indicators absent, explicit pressed graph channels, keyboard sample pinning, revealed/dynamically bounded graph-splitter metadata, retained-graph palette invalidation, and shortcut badges excluded from name computation. |
| [`settings-accessibility.test.ts`](../web/tests/settings-accessibility.test.ts) | Studio appearance choice and obsolete-choice absence, accent-swatch selection/focus, built-in preset full-card activation and independent description expansion, persistent single-flight scene import across rerenders, compact checkbox sizing, and safe new-tab third-party notice behavior. |
| [`theme-contrast.test.ts`](../web/tests/theme-contrast.test.ts) | Complete Studio/Dark/Void/Light surface/text combinations, Studio's distinct chromatic identity/layers, and black, white, and intermediate custom accents meet text, neutral-focus, accent/accent-dark ink, and filled-control focus-cue thresholds. |
| [`tour-modal.test.ts`](../web/tests/tour-modal.test.ts) | App-shell inertness, pointer blocking, focus trapping/restoration, active-step progress, live announcements, and modal cleanup. |
| [`zoom-accessibility.test.ts`](../web/tests/zoom-accessibility.test.ts) | Page-zoom-restricting viewport metadata, global modified wheel/keyboard/gesture suppression, canvas-only unmodified wheel/touch zoom, restored strong heading accents, mobile heading presence, and selectable reference content. |

### Real-browser acceptance

| Test file | Protected behavior |
| --- | --- |
| [`e2e/accessibility.spec.ts`](../web/e2e/accessibility.spec.ts) | Production boot without console/page errors; axe WCAG A/AA scan with only the deliberate browser-page-zoom `meta-viewport` exception waived; keyboard play/tabs/splitters/full-card library activation; undo after scene replacement; rendered-canvas pointer alignment; 390 x 844 transient inspector behavior; modal-tour focus/inertness/restoration; and contained 320-CSS-pixel/200%-text layout. |

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
  precedence remain fast and diagnostically precise.
- **Browser tests** exercise the built application with Chromium and axe so
  computed accessibility trees, focus, reflow, pointer coordinates and runtime
  console failures are covered across subsystem boundaries.

When fixing a defect, add the smallest test that pins the violated invariant in
the closest existing file. Add a new test file only when the behavior is a new
coherent area. Tests should name the mechanism and expected physical/UI
contract, not merely replay one bug report.

## Performance and determinism expectations

Performance work must preserve these boundaries:

- Normal-mode physical results may depend on scene state and authored solver
  controls, never measured frame duration or CPU speed. Performance mode is an
  explicit exception: measured load selects a documented approximation level;
  the engine result is deterministic for that selected level.
- A slow frame may advance less simulated time, but each completed step uses
  the same state-derived resolution and force/constraint order.
- Presentation-only quality, such as Normal-mode trail vertex count,
  Performance DPR/frame cadence, or DOM refresh culling, may react to measured
  cost.
- The full opaque canvas is retained while its visual generation is unchanged;
  clock-only empty/settled steps must not repaint, while every visible model,
  camera, view, trail, selection, theme, resize, or interaction change must.
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
MathLive fonts are emitted as static assets. Vite also copies
`public/THIRD_PARTY_NOTICES.txt` into the production root so the Help link can
open the upstream MathLive MIT and OpenDyslexic SIL OFL notices. Build output is
ignored by Git.

## Continuous integration and deployment

`.github/workflows/ci.yml` validates every pull request with only
`contents: read`: checkout, exact Node 22.23.1 setup, `npm ci`, Vitest plus the
README-count check, production build, Chromium/system-dependency installation,
and Playwright/axe acceptance. Every third-party action reference is an
immutable commit SHA for its documented major version.

`.github/workflows/deploy.yml` runs on pushes to `main` and manual dispatch.
The build job:

1. checks out the repository;
2. installs Node 22.23.1 with npm caching keyed by `web/package-lock.json`;
3. runs `npm ci` in `web`;
4. runs Vitest with human and JSON reporters;
5. runs `scripts/check-test-count.mjs` against the generated result so the
   README lower-bound badge cannot become false;
6. runs the production build;
7. installs Chromium and runs the browser acceptance suite; and
8. uploads `web/dist` as the Pages artifact.

The build job has only `contents: read`. The deploy job alone receives
`pages: write` and `id-token: write`; it waits for build, uses the GitHub Pages
environment, and publishes through the immutable `actions/deploy-pages`
revision. The workflow has a single Pages concurrency group and cancels an
older in-progress deployment when a newer one starts.

`.github/dependabot.yml` checks npm packages under `web/` and GitHub Actions
weekly. Review and validate update pull requests normally; the schedule does
not auto-merge them.

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
- Open each graph, scroll/zoom it, toggle explicit channels/units, inspect and
  pin two samples by pointer and keyboard, and rewind.
- Save, rename, describe, download, import, load, and delete a scene.
- Edit a formula in text and typeset modes; verify invalid input remains
  recoverable and lazy loading fallback is usable.
- Keyboard-navigate controls and overlays; verify focus rings, Escape order,
  live status output, and no shortcut fires while typing.
- Confirm Ctrl/Cmd-wheel, trackpad page pinch, and Ctrl/Cmd `+`, `-`, and `0`
  do not page-zoom, while unmodified simulation/graph wheels and their scoped
  touch gestures still zoom at the pointer.
- Check phone layout, real touch pan/pinch gestures, 200% text scaling, reduced
  motion, dyslexic font, Studio/Dark/Void/Light themes, and extreme custom
  accents.

Document any resulting behavior change in present tense in the appropriate
handbook page; do not append a release history to these pages.
