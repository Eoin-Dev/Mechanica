# Source reference

This is the file-level map of the current implementation. It accounts for
every file under `web/src` and the project entry/configuration files that shape
runtime, testing, and deployment.

Paths in the tables are relative to `web/src` unless stated otherwise.

## Application entry files

| File | Responsibilities and important interfaces | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`main.ts`](../web/src/main.ts) | Browser composition root. Imports CSS, constructs `App`, panels, overlays and tour; wires toast output, overlay callbacks, keyboard dispatch, resize observation, page-zoom suppression, first preset, first-visit behavior, and development handles. | Called by the module script in `index.html`. It is the only place that knows all fixed DOM IDs and assembles all UI components. Global listeners must preserve modal/shortcut/input precedence. |
| [`app.ts`](../web/src/app.ts) | Exports `PHYSICS_DT`, `GraphMode`, `Settings`, `sanitizeSettings`, `Panel`, `App`, and re-exports `PRESETS`. Owns playback scheduling, world/camera/view state, world replacement, undo/rewind/reset, preset loading, selection, property clipboard, scene framing, saving, graph/trail sampling, overload diagnosis, culling, rendering, and per-frame UI refresh. | Imports engine, scene, interaction, render, plots, DOM layout constants, and theme. Constructed once by `main.ts`; most UI modules receive the instance. Every stepping path must apply the current performance preference. Every whole-world swap must reset direct references held by interaction and derived views. |
| [`style.css`](../web/src/style.css) | Global reset, theme variables, flex application layout, toolbar/palette/inspector/dock/hint bar, reusable controls, formula editor/guide, selection groups, overlays, library/settings/help/tour, toasts, focus rings, phone/touch layouts, OpenDyslexic faces, and reduced-motion rules. | Imported by `main.ts`; selectors depend on `index.html` IDs and classes created throughout `ui/`. The shared 760 px phone breakpoint must stay aligned with `PHONE_QUERY`. Bare `:focus-visible` behavior is protected by tests. |

## Core utilities

| File | Responsibilities and exports | Dependencies and invariants |
| --- | --- | --- |
| [`core/vec.ts`](../web/src/core/vec.ts) | `Vec2`: allocating arithmetic, in-place mutation, dot/length/distance, rotation, and copy. | Dependency-free. Used throughout engine, camera, renderer, interaction, and presets. Methods named `*Ip`/setters mutate; other arithmetic returns new vectors. |
| [`core/guards.ts`](../web/src/core/guards.ts) | Deserialization guards `numOr`, `numIn`, `intIn`, `boolOr`, `clamp01`, `strOr`, `idOr`, `arrayOr`, and `colorOr`. | Used by bodies, links, world, and settings-adjacent loading. Inputs from scene JSON are untrusted runtime values. Booleans are accepted only as booleans, without truthiness coercion. IDs must remain finite integers below the counter-safety ceiling; guard fallbacks must not merge distinct invalid objects. |
| [`core/expr.ts`](../web/src/core/expr.ts) | Restricted force-field language. Exports environment/function types, `ExprError`, prototype-free `nameTable`, variable/constant/function tables, arity checking, AST/operator types, `parseSource`, and `compileExpr`. Contains tokenizer, recursive-descent parser, AST-to-closure compiler, Python-like numeric/logic semantics, and compile probe. | Imported by `World`, math formatting, interaction key tables, and formula tests. User source must never reach `eval`/`Function`. Lookup tables must have no prototype. Parser precedence and source semantics must remain aligned with `mathfmt.ts`. |
| [`core/mathfmt.ts`](../web/src/core/mathfmt.ts) | Converts the expression AST to normalized source or LaTeX and parses MathLive LaTeX back into AST/source. Exports `isMathRenderable`, `sourceToLatex`, `astToSource`, `latexToAst`, and `latexToSource`. | Imports compiler symbol/arity tables. Used by inspector, formula guide, and math editor. Scene source text is canonical; conversion must preserve meaning, precedence, names, arity, and floating-point values. Text-only constructs must stay out of the typeset editor. |

## Engine

| File | Responsibilities and exports | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`engine/body.ts`](../web/src/engine/body.ts) | Exports `Color`, material presets, body palette, `BodyDict`, `Body`, `WallDict`, and `Wall`. Defines physical/visual properties, identity counters, inverse mass/inertia, kinetic energy, and guarded serialization. | Imports guards and `Vec2`; used by every physical/render/edit subsystem. Anchors are body-shaped link endpoints but are locked, named consistently, and excluded from mutual gravity. Transient solver/interaction fields are never serialized. Colour arrays must be copied. |
| [`engine/links.ts`](../web/src/engine/links.ts) | Exports rod/spring JSON types, `DistanceLink`, `SpringLink`, `Link`, and `linkFromDict`. Implements Hooke plus axial damping, one-sided elastic strings, link potential energy, and guarded reconstruction. | Imports bodies and guards; used by world, renderer, interaction, inspector, presets, and performance solver. Links hold direct body references. Distance warm-start state and effective spring coefficients are transient. Tension-only links must never push. |
| [`engine/contacts.ts`](../web/src/engine/contacts.ts) | Exports `RESTING_SPEED`, diagnostic `Contact`, `ContactStatic`, capsule helpers, kinematic clear/sweep functions, `ContactCache`, and `solveContacts`. Implements size-aware spatial hash, circle/capsule narrowphase, manifold effective masses, impact propagation, warm-started sequential impulses, Coulomb friction/torque, split projection, and static-friction anchoring. | Imports only body/wall. Called by `World`; sweep helpers are also called by `CanvasController`. Pair keys must be stable across broadphase order. Position correction must not change velocity. Per-step static detection state cannot outlive structural edits. |
| [`engine/perf.ts`](../web/src/engine/perf.ts) | Exports performance caps/constants, `PerfSolver`, and `clampSpeeds`. Packs spring endpoints/rows, performs XPBD spring projection, movement bounds, velocity feedback, bounded damping, strain limits, scatter, and global speed/spin caps. | Imports body and spring types; owned by `World`. This is the only alternate spring solver. It must remain stable for arbitrary inspector stiffness/damping/mass ratios and must not serialize its browser preference or scratch state. |
| [`engine/world.ts`](../web/src/engine/world.ts) | Exports integrator names/type, encounter constant, scene anchor/runaway helpers, field/driver types and classes, `WorldDict`, and `World`. Implements guarded reconstruction and duplicate object-ID repair, per-step caches, all smooth forces, packed N-body gravity, driver/field evaluation, acceleration-level rod tension, three integrators, encounter slicing, step pipeline, rod XPBD correction, sanitization, subdivision diagnostics, energy/momentum/centre/angular momentum, removal, and serialization. | Imports only core and engine modules. Used by app, scene, renderer, inspector, interaction type/value imports, and presets. The engine must stay headless. Body/wall IDs must be unique within their collections before reference/cache construction; link IDs are unique within each link class because rods and springs have separate identity namespaces. Object lists/properties are fixed within a step. Effective performance settings must not overwrite authored values. The force/energy models must agree. |

## Scene and persistence

| File | Responsibilities and exports | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`scene/snapshot.ts`](../web/src/scene/snapshot.ts) | Exports full snapshot/restore, structural digest, `RewindBuffer`, `UndoStack`, saved-scene operations, `SceneSaveError`, description metadata, download, and upload. Implements digest-prefiltered and exactly verified compact rewind frames, browser storage namespaces/name normalization, rollback-aware scene mutations, scene JSON import/export, and storage error reporting. | Imports `World`; used by `App` and library overlay. A digest match cannot authorize a delta without exact structural comparison; the optional `RewindBuffer` digest dependency exists so tests can force a collision, while production uses `structuralDigest`. Scene payload must remain portable and metadata separate. Multi-key mutations preserve or restore source data before reporting failure. Undo is committed-edit history; rewind is rolling simulation history. Whole-world restore creates a fresh object graph. |
| [`scene/presets.ts`](../web/src/scene/presets.ts) | Exports `PresetHints`, `Preset`, `sceneWork`, solver-work budget, `PRESETS`, and derived `CATEGORIES`. Contains deterministic scene builders/helpers for gravity, pendulum, oscillator, collision, projectile, soft-body, and chaos examples, plus central solver-cost capping. | Imports engine model and `Vec2`; used by app/library and extensively by tests. Every build must return fresh deterministic state, valid link identity, affordable solver settings, and descriptions/hints matching the constructed demonstration. |

## Rendering

| File | Responsibilities and exports | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`render/camera.ts`](../web/src/render/camera.ts) | Exports zoom limits, `Camera`, `niceNumber`, and compact `formatG`. Provides world/screen conversion, resize, pan, zoom-at-point, visible bounds, and scale-bar length. | Imports `Vec2`; owned by `App`, used by drawing and interaction. World y is up while screen y is down. Cursor-anchored zoom must preserve its world point. |
| [`render/trail.ts`](../web/src/render/trail.ts) | Exports `Trail`, a fixed-capacity x/y/time typed-array ring with chronological access, screen-space sampled output, expiration, resize, serial phase, and amortized bounds. | Used by `App` and `draw.ts`. Append must be O(1). Decimation uses monotonic sample serials, not rotating array indices. Bounds may be conservatively large between recomputations but never exclude live points. |
| [`render/draw.ts`](../web/src/render/draw.ts) | Exports vector scales, `Selectable`, `ViewSettings`, grid/snap helpers, arrow/world/velocity-handle/scale-bar drawing, and segment distance. Implements reusable colour/width `Path2D` batches, visible culling, trails/fading/decimation, links/strings/springs, bodies/anchors, selections, vectors, contacts, centre of mass, grid diagnostics, and labels. | Imports engine model, camera/trails, and live theme bindings. Called by `App` and controller overlays. Drawing must not mutate physical state. Performance rendering may simplify visuals only. Scratch batches/arrays must be reset after use. |

## Interaction

| File | Responsibilities and exports | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`interact/tools.ts`](../web/src/interact/tools.ts) | Exports tool list/type, shortcut and help tables, and `CanvasController`. Implements picking, active-tool hints, pointer/touch/pinch routing, pan/zoom, body/wall/link creation, position and velocity drags, wall endpoint edits, box selection, deletion reconciliation, duplication, and interaction overlays. | Imports core, engine, render helpers, touch predicate, and `App` as a type. Constructed/owned by `App`. Any world replacement must call `resetInteraction` because pending links and drags hold direct object references. Position drag restores original velocity; velocity drag is the explicit throw/edit path. All deletion routes must use the batched common path. |

## UI foundation and content

| File | Responsibilities and exports | Dependencies, callers, and invariants |
| --- | --- | --- |
| [`ui/dom.ts`](../web/src/ui/dom.ts) | Exports element/control helpers, media predicates/subscription and breakpoint, `RefreshGroup`, splitter bounds/logic, `ModalFocus`, button/slider/numeric/text/checkbox/segmented/colour controls, number/colour formatting, and layout helpers. | Used by all DOM UI modules and `App` for layout constants/reduced motion. Controls read through getters and stop refresh during edits. Modal focus must trap and restore. Phone query must match CSS. Hidden self-revealing controls must not be permanently refresh-culled. |
| [`ui/icons.ts`](../web/src/ui/icons.ts) | Exports the `ICONS` map of inline SVG strings. | Used by panels, inspector, overlays, guide, and tour-adjacent controls. Values are trusted source constants inserted as markup; user data must never enter this table. |
| [`ui/theme.ts`](../web/src/ui/theme.ts) | Exports `ThemeName`, supported names, validation, live semantic colour bindings, theme/accent application, hex parsing, default accent, cached Canvas CSS conversion, lighten, and scale. | Used by app, renderer, plots, panels, and settings. Theme changes must update both exported bindings and CSS variables. CSS colour cache is bounded. |
| [`ui/plots.ts`](../web/src/ui/plots.ts) | Exports series colour selection, graph window/sample/history constants, `GraphView`, `TimeSeries`, and `PhasePlot`. Implements bounded rolling storage, block compaction, time truncation, legend toggles, visible-range search, autoscale/easing, channel rendering, and phase rendering. | Used by `App` and `GraphDock`. Non-finite samples are rejected. Time-series retention and graph draw cost are bounded. Reduced motion removes scale animation, not data motion. |
| [`ui/shortcuts.ts`](../web/src/ui/shortcuts.ts) | Exports dismissable/host interfaces and `handleShortcut`. Encodes focus ownership, Escape/modal precedence, edit commands, tool selection, playback, speed, selection, camera, graph, and overlay shortcuts. | Called by `main.ts`; tested with a host stub. Must not hijack keys owned by focused controls and must prevent defaults only for consumed commands. |
| [`ui/panels.ts`](../web/src/ui/panels.ts) | Exports `Toolbar`, `overlayToggles`, `Palette`, `HintBar`, and `GraphDock`. Constructs persistent controls, toolbar clock, tool groups, status/hints, graph canvas/view navigation/legend behavior, and splitters. | Imports app/engine/tool/plot/theme/DOM helpers. Instances are registered as `Panel`s in `main.ts`. DOM updates should be state-change-based; replacing the active play button node during a click is forbidden. Overlay callbacks are populated by `main.ts`. |
| [`ui/inspector.ts`](../web/src/ui/inspector.ts) | Exports `Inspector`. Implements responsive/collapsible inspector, structure-key rebuilding, selection/world/view tabs, single/multi object controls, materials, colours, driver management, alignment/distribution, link conversion, field/math editing, solver/performance messages, and action buttons. | Imports most public app/engine/render types and DOM controls. Constructed by `main.ts`; registered through app callbacks/panels. Rebuild only when structure changes; ordinary values refresh in place. Link conversion must replace the selected object in the world. Commits must push undo exactly at interaction boundaries. |
| [`ui/overlays.ts`](../web/src/ui/overlays.ts) | Exports `Library`, `SettingsPanel`, and `Help`. Implements preset categories/cards, saved-scene actions and storage-error toasts, appearance/interaction/accuracy preferences, help content, modal focus, and open/close/toggle behavior. | Imports app, presets, snapshot storage, theme and DOM helpers. Constructed/wired by `main.ts`. Card action buttons stop load propagation. Failed scene mutations must not continue through the success render path. Scene replacement must use app lifecycle methods. Device-specific help must not advertise unavailable gestures. |
| [`ui/mathedit.ts`](../web/src/ui/mathedit.ts) | Exports `mathEdit`. Lazily imports MathLive/CSS, starts with text-edit fallback, bridges source/LaTeX, installs inline shortcuts, manages commit/revert/error/focus, and preserves usability on load failure. | Imports math conversion and DOM text editor. Used by inspector. Stored source remains canonical. Do not replace a focused fallback control. Invalid user input remains visible for repair. |
| [`ui/guide.ts`](../web/src/ui/guide.ts) | Exports `FormulaGuide`. Builds paged formula documentation, lazy static MathLive rendering, tables/examples, and clickable field recipes. | Imports app, math conversion, `ForceField`, recipes, icons and DOM helpers. Constructed by `main.ts`. Plain source must remain readable if typesetting is unavailable. Recipe clicks create undoable world fields. |
| [`ui/guide-recipes.ts`](../web/src/ui/guide-recipes.ts) | Exports `Recipe` and `RECIPES`, the named force-field examples shown by the guide. | Imported only by `guide.ts`. Every recipe source must compile under the expression language and its blurb must match the resulting force. |
| [`ui/tour.ts`](../web/src/ui/tour.ts) | Exports `Step`, tour `STEPS`, and `Tour`. Builds guided-tour cards, locates visible targets, creates tiled spotlight holes/rings, positions cards, handles navigation/finish/resize/scroll, and records completion in app settings. | Constructed by `main.ts`; referenced by shortcut/help/settings hosts. Spotlight geometry must support multiple targets and responsive visibility. The tour has first Escape priority and must clean up listeners/DOM on finish. |

## Font assets

| File | Purpose and invariant |
| --- | --- |
| [`fonts/OpenDyslexic-Regular.woff2`](../web/src/fonts/OpenDyslexic-Regular.woff2) | Bundled regular face used when the dyslexia-friendly preference adds the body class. Must remain at the stylesheet URL or the `@font-face` source must change with it. |
| [`fonts/OpenDyslexic-Bold.woff2`](../web/src/fonts/OpenDyslexic-Bold.woff2) | Bundled bold face for the same preference. Weight declaration and filename must stay aligned. |

## HTML, package, build, and deployment files

| File | Role and important contract |
| --- | --- |
| [`web/index.html`](../web/index.html) | Declares metadata, favicon, application shell IDs, accessible canvas/status regions, modal roots, and `/src/main.ts` module entry. IDs are hard dependencies of `main.ts` and CSS. |
| [`web/package.json`](../web/package.json) | Declares ESM package, Vite/Vitest/TypeScript/jsdom development stack, MathLive runtime dependency, and dev/build/preview/test scripts. |
| [`web/package-lock.json`](../web/package-lock.json) | Reproducible npm dependency graph used by `npm ci` in CI. Update through npm, not by hand. |
| [`web/tsconfig.json`](../web/tsconfig.json) | ES2022/bundler/DOM compilation, strict types, unused checks, fallthrough protection, isolated modules, Vite types; includes source and tests. |
| [`web/vite.config.ts`](../web/vite.config.ts) | Relative production asset base, ES2022 target, lazy MathLive chunk warning allowance, real CSS handling in tests, and extended verification-suite timeout. |
| [`web/scripts/check-test-count.mjs`](../web/scripts/check-test-count.mjs) | Reads JSON test output in CI and enforces the README's lower-bound test badge without hard-coding a volatile exact total in prose. |
| [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | On `main` push/manual run: Node setup with npm cache, `npm ci`, test run plus JSON results, badge-bound check, production build, Pages artifact upload, and deployment with Pages/OIDC permissions and deployment concurrency. |
| [`.claude/launch.json`](../.claude/launch.json) | Local app launch configuration: starts the Vite dev server from `web` on a strict configured port. |
| [`.gitignore`](../.gitignore) | Ignores dependencies, production output, and generated test results. |

## Important public interface index

These are internal module interfaces rather than a published npm API, but they
are the stable seams used throughout the repository:

- Model: `Vec2`, `Body`, `Wall`, `DistanceLink`, `SpringLink`, `World`,
  `ForceField`, `Driver`.
- Serialization: `BodyDict`, `WallDict`, `RodDict`, `SpringDict`, `FieldDict`,
  `DriverDict`, `WorldDict`, `snapshot`, `restore`.
- Simulation: `World.step`, `solveContacts`, `PerfSolver`, integrator names,
  diagnostics and removal helpers.
- App: `App`, `Settings`, `sanitizeSettings`, `Panel`, `GraphMode`.
- View/input: `Camera`, `ViewSettings`, `Selectable`, `Trail`,
  `CanvasController`, `Tool`.
- UI foundation: `Control`, `RefreshGroup`, `ModalFocus`, reusable control
  constructors, `TimeSeries`, `PhasePlot`, `handleShortcut`.
- Content: `Preset`, `PresetHints`, `PRESETS`, `CATEGORIES`, formula AST/parser/
  compiler and source/LaTeX converters.

Changing a field/type at one of these seams normally affects several modules,
tests, and at least one handbook page.

## Documentation ownership

Use this table before completing a code change:

| Changed area | Handbook pages to check |
| --- | --- |
| `core/expr.ts`, `core/mathfmt.ts`, `ui/mathedit.ts`, `ui/guide*` | [Data, formulas, and scenes](data-formulas-scenes.md), [Application and UI](application-ui.md), this reference. |
| `engine/*` | [Physics engine](physics-engine.md), [Architecture](architecture.md) if the step/data flow changes, scene schema page if serialized fields change, this reference. |
| `app.ts`, `main.ts` | [Architecture](architecture.md), [Application and UI](application-ui.md), settings/schema page where applicable, this reference. |
| `interact/tools.ts`, `render/*` | [Application and UI](application-ui.md), architecture for lifecycle changes, this reference. |
| `scene/snapshot.ts`, `scene/presets.ts` | [Data, formulas, and scenes](data-formulas-scenes.md), application page for user workflow changes, this reference. |
| `ui/*`, `style.css`, `index.html`, fonts | [Application and UI](application-ui.md), architecture for composition/focus lifecycle, data/formula page where relevant, this reference. |
| Tests, scripts, package/config/workflow | [Testing and operations](testing-and-operations.md), this reference, and README commands/deployment if user-facing. |

Always update descriptions to the resulting current behavior. Do not add a
history note saying that an old implementation was replaced.
