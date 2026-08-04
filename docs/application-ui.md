# Application and UI

`App` is the browser-facing coordinator. It owns the live world and everything
needed to play, edit, inspect, visualize, save, and replace it. DOM components
are plain TypeScript classes/functions; the canvas is rendered through Canvas
2D.

## Application state

The important `App` state falls into these groups:

| Group | State |
| --- | --- |
| Model | `world`, current `selection`, property clipboard, undo stack, initial reset snapshot, rolling rewind history. |
| Playback | `playing`, speed multiplier, fixed-step accumulator, overload state, adaptive-resolution toggle/current factor, FPS observations. |
| View | `camera`, `ViewSettings`, trails keyed by body ID, adaptive trail quality, graph mode and series. |
| Interaction | One `CanvasController`, plus callbacks for selection and world replacement. |
| Preferences | Sanitized browser `settings`, performance mode, culling, dragged-wall collision, appearance and layout values. |
| UI integration | Panel list, toast callback, soft-body hint state, energy cache. |

The app does not wrap engine objects in view models. Inspector controls and the
controller edit the current `Body`, `Wall`, `Link`, or `World` directly, then
commit undo state and request structural refresh where necessary.

## Playback and time controls

### Play and pause

`togglePlay()` captures the initial snapshot if needed and flips playback.
The frame loop advances fixed quanta only while playing; camera follow/auto-fit
and UI refresh continue while paused.

The speed range is 0.01x through 16x. Below 1x the app shortens each simulated
quantum rather than skipping display frames, giving smooth and more finely
resolved slow motion. At high speed it schedules more normal quanta until the
per-frame step/time budgets are reached.

### Single-step and rewind

`stepOnce()` pauses, advances two 1/120 s quanta (one nominal 60 Hz display
frame), and uses the same adaptive subdivision and trail recording path as
normal playback.

`stepBack()` pauses and asks `RewindBuffer` for the previous recorded display
frame. It reconstructs a new world, resets all live gestures, retains selected
body IDs where the corresponding reconstructed objects exist, and truncates
time-series graphs at the rewound clock.

### Reset and time jump

The initial snapshot is the scene setup as first played/stepped, including
edits committed at time zero. Reset restores it, pauses, clears derived
display/history state through `replaceWorld`, and preserves the same initial
snapshot for repeated resets.

The toolbar clock accepts a non-negative target time:

- a future target continues from a copy of the current state;
- a past target restarts from the initial snapshot;
- stepping is synchronous but limited by both a wall-clock budget and a hard
  step count;
- an incomplete jump installs the reached state and explains that entering the
  target again continues from there;
- work occurs on a copy so an exception cannot leave the visible scene
  half-advanced.

## Scene and edit operations

- `newScene()` installs an empty world, pauses, and pushes an undo entry so the
  clear can be reversed.
- `loadPreset()` installs a newly built world, resets undo, applies preset view
  hints, frames the initial bounds, captures reset/energy baselines, and arms a
  one-time soft-body drag hint.
- `pushUndo()` records a full serialized world after a committed edit. At time
  zero it also redefines the reset baseline.
- Undo/redo restore new object graphs and pause.
- Property copy/paste applies mass, radius, restitution, friction, locked, and
  collision flags to non-anchor bodies. Position, velocity, name, colour,
  rotation mode, links, and drivers are not in this clipboard.
- Lock toggle affects selected non-anchor bodies only.

All deletion routes use `CanvasController.deleteObjects()`. It groups bodies,
walls, and links, invokes batched world removals, drops body trails, removes
body-dependent links/drivers through `World.removeBodies`, and reconciles
hover, pending gestures, and selection once.

Duplication:

- copies selected bodies with new IDs and a small positional offset;
- preserves anchor identity/name rules;
- duplicates a link only when both endpoints were duplicated;
- duplicates drivers that target duplicated bodies;
- copies selected walls with new IDs and the same offset; and
- selects the new objects and creates one undo entry.

## Canvas tools

`CanvasController` owns all pointer interaction over the simulation canvas.

| Tool | Key | Behavior |
| --- | --- | --- |
| Select | `V` | Pick objects, replace/add/toggle selection, drag bodies or wall endpoints, drag empty space for filtered box selection, and expose a velocity handle for one selected body. |
| Pan | `H` | Drag the camera. Middle-drag and right-drag on empty space also pan from any tool. |
| Body | `B` | Place a new dynamic body at the snapped/unsnapped world point. |
| Anchor | `A` | Place a locked grey anchor that does not participate in mutual gravity. |
| Wall | `W` | Press-drag-release a capsule wall; Shift constrains the end direction to horizontal, vertical, or 45-degree increments. |
| Rod | `R` | Select two endpoints and create a bilateral `DistanceLink`. |
| String | `E` | Select two endpoints and create a tension-only `SpringLink`; the inspector can convert it to an inelastic rope. |
| Spring | `S` | Select two endpoints and create a bilateral `SpringLink`. |
| Eraser | `X` | Delete the picked selectable through the common deletion path. |

For link tools, clicking empty space for the first endpoint creates an anchor;
clicking empty space for the second creates a normal body. This permits a
pendulum or suspension link to be drawn without switching tools. Escape
cancels an unfinished wall or link before it dismisses other application state.

Picking is top-down by type and reverse draw/list order: bodies first, then
links, then walls. Pick padding is expressed in pixels and converted by camera
zoom so objects remain usable at different scales.

## Pointer and touch gesture routing

### Mouse and pen

- Primary button drives the active tool.
- Right-drag on a movable body sets velocity; right-drag elsewhere pans.
- Middle-drag pans.
- The mouse wheel zooms around the cursor; the world point under the cursor is
  kept fixed.
- A selected wall exposes endpoint/whole-wall dragging.
- The green velocity arrow tip is another route to exact velocity editing.

The document context menu is suppressed outside text inputs so right-button
gestures remain in the application. Losing window focus or changing fullscreen
resets interaction to prevent a swallowed pointer-up leaving a body held.

### Touch

One touch drives the active tool using touch-specific hint text that omits
keyboard and mouse-button references. A second touch cancels the one-finger
gesture and enters pinch mode. The controller tracks distance and midpoint to
combine zoom and pan. Only touch pointers enter the pinch map, preventing a
lost mouse pointer from creating a false two-finger gesture.

Touch-first detection uses `(pointer: coarse)`; phone layout separately uses
the CSS breakpoint `(max-width: 760px)`. A tablet can therefore receive touch
wording without receiving the phone drawer layout.

## Direct body manipulation

### Position drag

A primary drag has a small activation threshold. An inspect click therefore
does not mark a body held or touch its motion. Once active:

- each dragged body retains its cursor-to-centre offset;
- while paused, position changes only and the original velocity is untouched;
- while playing, position follows the cursor exactly and `held` makes the body
  infinite-mass to the solvers;
- the temporary velocity equals actual per-frame displacement divided by
  elapsed pointer time, capped at `DRAG_VEL_CAP`, so contacts and constraints
  see consistent relative motion;
- transitively link-connected movable bodies receive a per-substep chase speed
  cap to prevent interaction-driven runaway energy;
- on release or abort, held flags and chase caps clear and every dragged body
  recovers the velocity it had when the drag began.

Position dragging is therefore placement, not throwing. Intentional velocity
changes use right-drag or the velocity handle.

When dragged-wall collision is enabled, both paused and running drags call the
engine's kinematic capsule sweep. The default is disabled because passing a
held body through scenery is useful for editing and is the established scene
construction behavior.

### Velocity drag

Right-dragging a movable body or dragging its green handle sets `vel` from the
body centre to the world point using the renderer's velocity-arrow scale. This
is a real property edit and persists after release. The handle is hidden during
a primary position drag so the two gestures are not visually conflated.

### Walls, links, and pending references

Wall endpoint edits mutate `a` or `b`; whole-wall dragging preserves endpoint
separation. A pending link holds a direct reference to its first body.
`resetInteraction()` must therefore clear pending walls/links as well as drags,
pans, pinches, and box selections whenever the world object graph is replaced.

## Selection and inspector

Selection belongs to `App` as an array of `Selectable` references.

- Plain selection replaces the array.
- Shift selection adds/toggles.
- Rubber-band selection uses configurable filters for bodies, anchors, walls,
  springs, and rods.
- Delete acts on the whole selection.
- Object removal prunes references before a later frame can inspect a deleted
  object.

The inspector has `Selection`, `World`, and `View` tabs and supports desktop
collapse plus a phone drawer handle. It computes a structure key using object
type and ID, not ID alone, so a body and wall with the same numeric ID remain
different selections.

### Selection tab

For a single object it exposes type-specific state:

- body name, position, velocity, mass, radius, material, force, lock/collision
  and rotation behavior, colour, driver, and actions;
- anchor position and colour with anchor invariants preserved;
- wall endpoints, thickness, material, colour, and actions;
- spring/string natural length, stiffness, damping, one-sidedness/conversion;
- rod/rope length, compliance where applicable, and rope conversion.

Multi-selection groups objects by type, provides common bulk property controls,
driver operations, align/distribute operations for bodies, type-aware colours,
and batched delete actions. Distribution needs at least three bodies; two are
already evenly spaced and produce explanatory feedback.

### World tab

The world tab edits uniform/mutual gravity, point-mass mode, softening, drag,
global damping, integrator, substeps, iterations, custom force fields, and
drivers. Performance mode disables authored solver controls without overwriting
their values and shows an explanation banner. A preset whose substeps were
centrally cost-capped receives a transient explanatory note until the value is
edited.

### View tab

The view tab controls grid, snapping, labels, camera follow, velocity/
acceleration/force vectors, vector scale, trails and length, centre of mass,
contacts, spatial grid, and graph mode. These are application/view state, not
scene JSON.

## Camera and framing

`Camera` stores the world point at canvas centre, pixels per metre, and CSS
screen dimensions. Zoom is clamped between `MIN_ZOOM` and `MAX_ZOOM`.

- `toScreen` and `toWorld` perform the y-axis flip.
- `zoomAt` preserves the world coordinate under the input point.
- Grid and scale bar use shared “nice” 1/2/5 × 10^k lengths.
- `zoomToFit()` performs a one-time fit over body radii and wall thickness.
- Preset framing cannot zoom tighter than a complete fit; a hint may widen the
  view and propose a centre within bounds.
- Follow mode eases the centre toward a selected body.
- Auto-fit continuously eases toward current scene bounds, while a user may
  zoom farther out and preserve that ratio. A hard clamp guarantees all live
  bounds remain visible even before easing catches up.
- Reduced-motion preference makes follow/auto-fit camera changes immediate
  rather than animated.

Runaway culling is centred on fixed scene furniture, not the camera. Panning or
following cannot cause bodies to be deleted.

## World rendering

`drawWorld()` receives all display state explicitly and draws in Canvas 2D.
Major behavior includes:

- visible-bounds culling for bodies, walls, links, and whole trails;
- style batching through reusable `Path2D` groups so objects sharing colour and
  width use few draw calls;
- optional minor/major/axis grid, skipped if zoom would demand excessive lines;
- spring coils in accurate mode and simplified lines in performance mode;
- distinct taut/slack string styling;
- body fills/rings, anchor treatment, selection/hover outlines, labels, and
  spin markers;
- velocity, acceleration, and net-force arrows at configurable scale;
- centre-of-mass marker, contact normals/impulses, and spatial-hash overlay;
- scale bar drawn after interaction overlays.

`ViewSettings` defaults to grid on and all analytical overlays off. View state
is not serialized with the world; preset hints and user controls set it.

## Trails

Each moving body can own a `Trail`, a fixed-capacity typed-array ring buffer of
x/y/time samples.

- App recording occurs after every physical step, including adaptive steps.
- Encounter trace samples captured inside a world slice are drained first.
- Ordinary endpoints are added only after sufficient screen-space motion.
- Trail age is based on simulated time, so a stopped body's old path still
  expires and speed multipliers do not change the simulated history span.
- Rewind clears future-stamped trails; world replacement clears all trails.
- Trails belonging to removed bodies are deleted.
- Capacity changes retain the newest points and preserve monotonic serials.

Rendering decimates using a serial-based stride so the same physical samples
remain selected as the ring rotates. Corners and endpoints are preserved,
vertices are split into fading bands, and global/per-trail budgets limit draw
work. App trail quality rises slowly during cheap frames and falls quickly when
render cost exceeds its target.

## Graphs

The graph dock shows:

- energy: kinetic, potential, total;
- momentum: magnitude, x/y components, and angular momentum;
- phase space: x-vx or y-vy for the selected body.

`App.recordGraphSample()` records every time-series family regardless of which
one is displayed, so switching modes does not create gaps. Sampling cadence is
capped in simulation time from the visible window and maximum point budget.
Mutual-gravity energy is computed through the per-frame cache.

`TimeSeries` keeps named channel arrays with a logical head index. Expired
history advances the head in O(1); backing arrays are compacted only in blocks.
It retains a bounded time window and hard point cap, updates an equal-time
sample in place, clears on backward time, rejects non-finite samples, and lets
legend clicks hide channels. Rendering uses binary search to find the visible
range and smooths only shrinking y-axis bounds. Reduced motion snaps the range.

`PhasePlot` stores bounded x/vx/y/vy tuples, compacts in blocks, draws one axis
pair in a square region, and marks the latest point. Selecting a different body
clears the previous phase trajectory.

The graph dock supports live following, scroll-back, wheel zoom, pan, reset,
legend toggles, and a resizable splitter. It avoids redrawing unchanged data
unless autoscale easing is still active.

## DOM control system

`ui/dom.ts` supplies the common construction and behavior layer:

- `el` creates an element, assigns text/classes/attributes, and appends
  children without templating.
- `button`, `slider`, numeric/text edits, checkbox, segmented control, colour
  editor, section, and half-row return `{ root, refresh? }` controls.
- sliders map a fixed internal range to linear or logarithmic values; paired
  numeric input allows exact edits and commit/revert behavior.
- `RefreshGroup` polls controls and optionally culls scrolled-out refresh work.
- `splitterDrag` handles pointer capture, constraints, and commit callbacks.
- media predicates reuse live `MediaQueryList` objects and safely degrade when
  `matchMedia` is unavailable.
- `ModalFocus` labels the dialog, captures/restores prior focus, traps Tab
  navigation, and keeps focus inside an open overlay.

Buttons derive accessible names from visible labels or tooltips. Icon markup
comes from the internal constant `ICONS` table, not user input.

## Panels and overlays

### Persistent panels

- **Toolbar:** playback, rewind/step/reset, speed, editable clock, undo/redo,
  clear, fit/auto-fit, library, settings, and FPS.
- **Palette:** grouped tool buttons, active state, shortcut badges, and tool
  descriptions.
- **Hint bar:** active gesture hint plus current time, body/contact counts,
  adaptive factor, energy drift, and pointer coordinates where appropriate.
- **Graph dock:** graph mode, view controls, canvas rendering, legend hit
  testing, splitter, and contextual gesture hint.
- **Inspector:** object/world/view editing described above.

`main.ts` adds a lightweight panel for the physics/render overload message.

### Modal overlays

- **Library:** category-filtered built-in presets and locally saved scenes.
  Scene cards support load, rename, description, download, and delete; the
  action buttons stop propagation so they do not also load the card.
- **Settings:** appearance, theme/accent/font, accessibility, interaction,
  adaptive resolution, performance mode, culling, help, and tour access.
- **Help:** getting-started steps and device-appropriate shortcut reference.
- **Formula guide:** variables, operators, functions, logic, math-editor help,
  and clickable field recipes.

Clicking an overlay backdrop closes it. Modal focus returns to the prior
element on close. Shortcut handling gives open overlays and the guided tour
priority over simulation commands.

## Shortcuts

`handleShortcut()` is DOM-light and accepts a `ShortcutHost`, making precedence
testable without constructing the whole app. It:

1. Lets focused text controls keep editing keys and lets range/checkbox/button
   controls keep keys they own.
2. Handles escape in order: active tour, topmost open overlay, pending canvas
   gesture, then selection.
3. Applies modifier edit commands (undo, redo, save, duplicate, copy/paste,
   reset).
4. Applies tool keys and view/playback commands.
5. Prevents browser defaults only for a command the app actually consumed.

The toolbar clock and formula editors also stop key propagation while editing.
Document-level page zoom shortcuts are suppressed because page zoom would
misalign canvas layout; canvas/graph zoom gestures remain available.

## Themes and responsive behavior

`theme.ts` defines named semantic palettes (`original`, `dark`, `void`, and
`light`) and exports live colour bindings consumed by canvas renderers. Theme
application updates both those bindings and CSS custom properties. An optional
hex accent derives hot/dark variants. Canvas colour strings are memoized by
packed colour/alpha value with a bounded cache.

The stylesheet owns:

- desktop flex layout, inspector and dock splitters;
- reusable controls and keyboard focus rings;
- formula, inspector, graph, library, settings, help, and tour presentation;
- phone layout at the shared 760 px breakpoint;
- touch-specific removal of irrelevant key badges/hover-only affordances;
- OpenDyslexic `@font-face` declarations and body class;
- light/dark `color-scheme` synchronization; and
- reduced-motion removal of decorative CSS transitions/animations.

On phones, the inspector becomes a drawer with a persistent handle; toolbar
content is trimmed/scrollable and the graph/overlay layout adapts. Splitter
sizes are clamped both while dragging and while sanitizing stored preferences.

## Accessibility

Accessibility behavior is part of the implementation contract:

- the canvas has an explanatory label;
- the toolbar brand provides the page's level-one heading;
- icon-only controls receive accessible labels/tooltips;
- transient toasts and overload messages are polite live status regions;
- modal overlays are labelled dialogs with trapped and restored focus;
- keyboard focus uses a shared `:focus-visible` ring, including compact custom
  controls and range inputs;
- mouse-activated non-text controls are blurred to prevent a stale focused
  button/slider from swallowing the next global shortcut, while keyboard
  activation retains focus;
- help/hints switch to touch wording where mouse/keyboard actions are
  unavailable;
- reduced motion affects decorative UI/camera/axis movement, not the physical
  simulation itself; and
- the dyslexia-friendly font and font scale are persisted preferences.

Tests protect focus rings, labels, modal semantics, device wording, tour
spotlights, splitter behavior, and shortcut ownership. See [testing and
operations](testing-and-operations.md).
