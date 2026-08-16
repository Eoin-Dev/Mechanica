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
| View | `camera`, `ViewSettings`, trails keyed by body ID, coalesced canvas invalidation state, adaptive trail quality, graph mode and series. |
| Interaction | One `CanvasController`, plus callbacks for selection and world replacement. |
| Preferences | Sanitized browser `settings`, performance mode, culling, dragged-wall collision, appearance and layout values. |
| UI integration | Panel list, toast callback, soft-body hint state, energy cache. |

The app does not wrap engine objects in view models. Inspector controls and the
controller edit the current `Body`, `Wall`, `Link`, or `World` directly. Every
user edit has an explicit boundary: `beginEdit()` snapshots the live state
before the first write, `commitEdit()` records the resulting transition, and
`cancelEdit()` discards an unused boundary. Capturing the live state is
important after playback, because the state immediately before an edit can
differ from the most recent committed history entry.

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
normal playback. Playback, single-step, and time-jump all use the same bounded
physics-batch primitive. It stops on the first contained divergence or thrown
solver error, pauses playback, clears pending accumulated time, aggregates the
affected body names, and emits one throttled diagnostic instead of repeatedly
retrying the bad state.

`stepBack()` pauses and asks `RewindBuffer` for the previous recorded display
frame. It reconstructs a new world, resets all live gestures, retains selected
body IDs where the corresponding reconstructed objects exist, and truncates
energy, momentum, and timestamped phase-portrait samples at the rewound clock.
The compact rewind buffer is limited to 3,000 frames and 48 MB. A frame that
cannot fit clears rewind history and produces a one-time explanation; ordinary
undo history remains separate.

### Reset and time jump

The initial snapshot is the scene setup as first played/stepped, including
edits committed at time zero. Reset restores it, pauses, clears derived
display/history state through `replaceWorld`, and preserves the same initial
snapshot for repeated resets.

The toolbar clock accepts a strict unsigned decimal or scientific-notation
target. Empty text, trailing characters, negative values, and non-finite values
are rejected rather than partially parsed. A target earlier than a scene's
nonzero loaded baseline is rejected with that baseline in the message.

- a future target continues from a copy of the current state;
- a past target restarts from the initial snapshot;
- the target is rounded to the nearest fixed 1/120 s quantum, so the installed
  clock differs by at most half a quantum;
- a backward jump that rounds to zero steps still installs the restored
  baseline instead of leaving the later live state visible;
- stepping is synchronous but limited by both a wall-clock budget and a hard
  step count;
- an incomplete jump installs the reached state and explains that entering the
  target again continues from there;
- a divergence or exception stops the shared physics batch at its first
  failure and installs only the bounded result; and
- work occurs on a copy so an exception cannot leave the visible scene
  half-advanced.

## Scene and edit operations

- Immediate actions and continuous gestures capture the exact pre-edit world
  before mutation and commit once at their interaction boundary. This covers
  canvas creation/deletion/paste/drag operations, Inspector buttons,
  checkboxes, sliders, colour controls and text/formula edits, formula recipes,
  and scene clearing. Invalid retained formula source is an undoable edit too.
- An unchanged transition adds no history entry. At time zero, a committed
  edit also redefines the reset and baseline-energy snapshot.
- Undo history holds at most 120 entries and 48 MB of UTF-16 snapshots. Redo
  entries are discarded with their byte accounting after a new edit. If a
  complete transition cannot fit, history resets to the resulting current
  state and the app explains that undo is unavailable for that edit.
- `newScene()` installs an empty world and pauses as one undoable transaction.
- `loadPreset()` installs a newly built world, applies preset view hints,
  frames the initial bounds, captures reset/energy baselines, and arms a
  one-time soft-body drag hint as one undoable scene replacement.
- `loadWorld()` handles saved and imported worlds the same way, fits the new
  scene, pauses, and announces that Ctrl+Z restores the previous scene.
  Failed reads and failed builds leave both the live world and history intact.
- `initializePreset()` is used only for startup and is the sole scene-loading
  path that resets undo history.
- Undo/redo restore new object graphs and pause. Every world replacement also
  clears live gestures, trails, graph samples, frame rewind, and other derived
  state before seeding the replacement's baseline.
- Property copy/paste applies mass, radius, restitution, friction, locked, and
  collision flags to non-anchor bodies. Position, velocity, name, colour,
  rotation mode, links, and drivers are not in this clipboard.
- Lock toggle affects selected non-anchor bodies only.

Saved-scene reads distinguish loaded, cancelled, missing, invalid, oversized,
and storage-error results. Cancelling the native picker is silent; malformed,
resource-limited, damaged saved data, and blocked/full storage receive specific
feedback. Uploaded files are rejected above 10 MiB, and the import button stays
disabled while its one file is being read, including if a Library tab rerender
replaces the button during that read. Quick-save names include local
milliseconds, and a repeated or DST-colliding timestamp receives `-2`, `-3`,
and subsequent collision-safe suffixes.

All deletion routes use `CanvasController.deleteObjects()`. It groups bodies,
walls, and links, invokes batched world removals, drops body trails, removes
body-dependent links/drivers through `World.removeBodies`, and reconciles
hover, pending gestures, and selection once.

Pulley assemblies refine the ordinary cascade rules. Deleting only the wheel
replaces its routed string with one ordinary inelastic `DistanceLink` of the
same total length. Deleting the pulley string removes its internal wheel but
keeps both particles. Deleting either particle removes the routed string and
wheel while leaving the other particle. When a bulk selection contains more
than one part, explicit link deletion is applied before body cascades so it
cannot accidentally create a replacement string the user also deleted.

Duplication:

- copies selected ordinary bodies/anchors with new IDs and a small positional
  offset; internal pulley wheels are not independently duplicated;
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
| Pulley | `P` | Place a fixed, non-colliding pulley with two ordinary non-rotating particles and one inextensible `PulleyLink`. A click near a wall endpoint mounts it there and starts the wall-side string tangent parallel to the wall. |
| Eraser | `X` | Click one selectable or hold and scrub across bodies, links, and walls. Samples are no more than three CSS pixels apart and the whole gesture is one undoable edit. |

For link tools, clicking empty space for the first endpoint creates an anchor;
clicking empty space for the second creates a normal body. This permits a
pendulum or suspension link to be drawn without switching tools. Escape
cancels an unfinished wall or link before it dismisses other application
state. If the first endpoint was auto-created, cancellation removes that
temporary anchor and cancels its uncommitted edit boundary.

Picking is top-down by type and reverse draw/list order: bodies first, then
links, then walls. Pick padding is expressed in pixels and converted by camera
zoom so objects remain usable at different scales. A pulley string is picked
from either straight leg; the wheel body owns the wrapped-arc hit area.

## Pointer and touch gesture routing

### Mouse and pen

- Primary button drives the active tool.
- Right-drag on a movable body sets velocity; while the button remains held,
  the target is recomputed every display frame and after every physics step so
  a parked pointer remains authoritative. Right-drag elsewhere pans.
- Middle-drag pans.
- An unmodified mouse wheel over the simulation canvas zooms around the cursor;
  the world point under the cursor is kept fixed.
- Ctrl/Cmd-wheel, trackpad page-pinch, and Ctrl/Cmd `+`, `-`, and `0` are
  suppressed at document level. Modified wheels are ignored by both local
  canvas handlers so they cannot also alter a simulation or graph camera.
- A selected wall exposes endpoint/whole-wall dragging.
- The green velocity arrow tip is another route to exact velocity editing.

The document context menu is suppressed outside text inputs so right-button
gestures remain in the application. Losing window focus or changing fullscreen
resets interaction to prevent a swallowed pointer-up leaving a body held or an
eraser transaction open.

### Touch

One touch drives the active tool using touch-specific hint text that omits
keyboard and mouse-button references. A second touch cancels the one-finger
gesture and enters pinch mode. The controller tracks distance and midpoint to
combine zoom and pan. Only touch pointers enter the pinch map, preventing a
lost mouse pointer from creating a false two-finger gesture.

Custom `touch-action: none` behavior is scoped to the simulation/graph canvases
and splitters. The viewport disables browser page scaling; the rest of the page
retains native scrolling and selectable reference text.

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
- the temporary solver-facing velocity is the actual per-frame displacement
  divided by elapsed pointer time and passed through a smooth speed-sensitive
  response. Slow positioning stays close to one fifth of hand speed, while
  faster motion is damped progressively more and approaches a 0.4 m/s solver-
  facing ceiling, so quick drags cannot proportionally energize linked systems;
- rod correction feedback across the held rigid component uses the same
  pointer-derived correction rate, rather than dividing a once-per-display-
  frame hand movement by a much shorter solver substep;
- in Normal mode, transitively link-connected bodies receive the solver's full
  constraint/contact response, so pendulums and chains do not trail behind an
  artificial chase-speed ceiling;
- in Performance mode, those linked bodies receive a per-substep chase speed
  cap as an intentional stability and throughput tradeoff;
- on release or abort, held flags and chase caps clear and every dragged body
  recovers the velocity it had when the drag began.

Position dragging is therefore placement, not throwing. Intentional velocity
changes use right-drag or the velocity handle.

The controller opens a transaction only when a drag first mutates the world and
commits once on release. Focus loss, fullscreen changes, pointer cancellation,
and a second touch restore temporary drag state before committing the final
position. A press that never crosses the activation threshold is unchanged and
creates no history entry.

When dragged-wall collision is enabled, both paused and running drags call the
engine's kinematic capsule sweep. The default is disabled because passing a
held body through scenery is useful for editing and is the established scene
construction behavior.

### Velocity drag

Right-dragging a movable body or dragging its green handle sets `vel` from the
body centre to the world point using the renderer's velocity-arrow scale. This
is a real property edit and persists after release. While the gesture is held,
`CanvasController.maintainVelocityDrag()` recalculates the requested velocity
from the body's latest centre to the parked pointer before display work and
after every live solver step. Gravity, contacts, and constraints therefore
cannot leave an integrated intermediate velocity on screen or make the arrow
flicker between pointer events. The handle is hidden during a primary position
drag so the two gestures are not visually conflated.

### Walls, links, and pending references

Wall endpoint edits mutate `a` or `b`; whole-wall dragging preserves endpoint
separation. A mounted pulley follows its chosen endpoint; its wall-side tangent
and wrapped arc are recomputed from the wall direction, while its particles
remain free bodies governed only by string tension and ordinary contacts. The
pulley wheel can be position-dragged even though it is physically fixed during
simulation. During the drag it acquires the nearest wall endpoint within 22
screen pixels and visibly snaps immediately. The latch stays attached until
the proposed pointer position moves more than 34 screen pixels from that
endpoint, avoiding threshold chatter while leaving an intentional breakaway
gesture. Releasing while latched preserves the mount. While paused, axle motion
uses existing string slack first; once the routed path reaches its natural
length, both particles receive the minimum shared axle translation needed to
keep the string taut instead of storing an explosive length error. If the wall
is deleted or becomes degenerate, the pulley detaches at its last valid position. A
pending link holds a direct reference to its first body.
`resetInteraction()` must therefore clear pending walls/links as well as drags,
pans, pinches, and box selections whenever the world object graph is replaced.

## Selection and inspector

Selection belongs to `App` as an array of `Selectable` references.

- Plain selection replaces the array.
- Shift selection adds/toggles.
- Rubber-band selection uses configurable filters for bodies, anchors,
  pulleys, walls, springs, and rods. A pulley string additionally requires its
  wheel and both particles to lie inside the box.
- Delete acts on the whole selection.
- Object removal prunes references before a later frame can inspect a deleted
  object.

The inspector has `Selection`, `World`, and `View` tabs. They use the
`tablist`/`tab`/`tabpanel` pattern with one tab in the page tab order;
Left/Right, Home, and End move focus and selection. The panel computes a
structure key using object type and ID, not ID alone, so a body and wall with
the same numeric ID remain different selections.

Desktop/tablet collapsed state follows the persisted `inspector_visible`
setting. The collapsed-edge and phone handles are real named buttons exposing
`aria-controls` and `aria-expanded`. Entering the phone layout starts a fresh,
transiently closed drawer session without writing the desktop preference;
returning above 760 px restores the persisted desktop state.

### Selection tab

For a single object it exposes type-specific state:

- body name, position, velocity, mass, radius, material, force, lock/collision
  and rotation behavior, colour, driver, and actions;
- anchor position and colour with anchor invariants preserved;
- wall endpoints, thickness, material, colour, and actions;
- spring/string natural length, stiffness, damping, one-sidedness/conversion;
- rod/rope length, compliance where applicable, and rope conversion;
- pulley-string total natural length, including both straight legs and its
  wrapped section, plus a transient four-arrow equal-tension overlay;
- spring, elastic-string, and inelastic-string axial-force overlays with one
  arrow on each endpoint; and
- a read-only pulley-wheel explanation with position dragging and deletion as
  its only physical editing actions, plus the pulley tension-overlay toggle.

Tension-vector choices are per-link view state, are not serialized, and do not
create undo entries. Multi-selection toggles every matching link, so separate
members of a chain can display simultaneously. Hovering any link-force arrow
shows its force as a two-component SI column vector; ordinary and elastic
strings display pulling tension, while a bilateral spring arrow reverses when
the spring is in compression.

Multi-selection groups objects by type, provides common bulk property controls,
driver operations, align/distribute operations for bodies, type-aware colours,
and batched delete actions. Distribution needs at least three bodies; two are
already evenly spaced and produce explanatory feedback.

### World tab

The world tab edits uniform/mutual gravity, point-mass mode, softening, drag,
global damping, integrator, substeps, iterations, custom force fields, and
drivers. Performance mode disables authored solver controls without overwriting
their values and shows a Performance-mode banner explaining that the settings
cannot be set while the mode is active; the hint bar reports
the current `high`, `fast`, `faster`, or `maximum` profile. A preset whose substeps were
centrally cost-capped receives a transient explanatory note until the value is
edited.

Formula edits retain invalid source and the resulting actionable error. The
field's compiled axes are updated atomically by the engine, while the retained
source change is committed as an ordinary undoable edit so the user can either
repair or undo it.

### View tab

The view tab controls grid, snapping, labels, camera follow, velocity/
acceleration/force vectors, vector scale, trails and length, centre of mass,
contacts, spatial grid, and graph mode. These are application/view state, not
scene JSON. Performance mode disables the Motion trails and Trail length
controls and displays an explanatory banner. The Normal-mode trail choice is
preserved for restoration when Performance mode is turned off.

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

- retaining the last complete opaque canvas image until a camera, view,
  interaction, scene, selection, trail, or rendered physics value changes;
- allowing empty or visually settled playback to advance simulation time and
  DOM readouts without repainting the full high-DPI canvas;
- visible-bounds culling for bodies, walls, links, and whole trails;
- reusable numeric-keyed `Path2D` batches for connected link and vector
  geometry, while each disjoint body uses one bounded current fill/stroke so
  Chromium does not raster a viewport-sized multi-body path;
- reused selection, label, and trail-index scratch collections so a displayed
  frame does not allocate replacement lookup containers for the same pass;
- optional minor/major/axis grid and spatial-hash overlay, each skipped if zoom
  would demand excessive lines. Both grids use independent narrow current
  paths instead of disjoint full-canvas `Path2D` batches, keeping raster cost
  from scaling path bounds across a high-DPI backing canvas;
- spring coils in accurate mode and simplified lines in performance mode;
  dense lattices keep their authored two-coil spring detail as the camera
  zooms in instead of multiplying decorative segments per link;
- distinct taut/slack string styling with a one-millimetre visual tolerance so
  microscopic projection residuals cannot make a pulley string flicker;
- routed pulley strings with two live tangent legs and a finite wrapped arc;
- body fills/rings, anchor treatment, selection/hover outlines, labels, and
  spin markers. A pulley has no permanent accent outline; selecting its wheel
  draws one tight accent rim exactly on its circumference;
- velocity, acceleration, and net-force arrows at configurable scale. Net
  force is the realised step-average resultant `mass * deltaVelocity / dt`, so
  it includes contacts and constraint impulses rather than only the latest
  smooth-force sample;
- opt-in link-force arrows, including four equal-tension arrows for a pulley
  and two endpoint arrows for a spring or string. The extra geometry pass runs
  only when at least one link has enabled the overlay, and pointer hover draws
  a two-decimal column-vector readout;
- centre-of-mass marker and contact normals/impulses;
- scale bar drawn after interaction overlays.

Performance rendering progressively caps backing density without changing CSS
coordinates or pointer alignment: levels 0-3 use at most `1.5`, `1.25`, `1`,
and `1` device pixels per CSS pixel. Maximum level draws only major/axis grid
lines, limits labels/vectors to the hovered or selected body, and suppresses
contact/spatial-grid diagnostics. If that profile remains overloaded or above
12 ms draw cost for at least 750 ms, it presents every other simulation frame
while physics and input continue at display cadence.

`ViewSettings` defaults to grid on and all analytical overlays off. View state
is not serialized with the world; preset hints and user controls set it.
The app compares direct camera and view values before each draw, so setters do
not need to duplicate invalidation bookkeeping. Physics comparison uses
reusable typed scratch and omits inactive velocity/acceleration data. Pointer
gestures invalidate explicitly so hover, rubber bands, pending links/walls and
parked drags remain continuous.

## Trails

Each moving body can own a `Trail`, a fixed-capacity typed-array ring buffer of
x/y/time samples.

Trails are unavailable in Performance mode. Enabling the mode clears existing
trail buffers and pending trace samples, stops sampling/aging/rendering work,
and blocks both the Inspector control and the `T` shortcut from changing the
preserved Normal-mode choice. Turning Performance mode off restores that
choice and begins a fresh trail rather than joining across the disabled span.

- App recording occurs after every physical step, including adaptive steps.
- Encounter trace samples captured inside a world slice are drained first.
- Ordinary endpoints are added only after sufficient screen-space motion.
- Trail age is based on simulated time, so a stopped body's old path still
  expires and speed multipliers do not change the simulated history span.
- Before recording resumes after rewind/re-simulation, future-stamped trails
  are cleared; whole-world replacement, including undo/redo, clears all trail
  samples.
- Trails belonging to removed bodies are deleted.
- Capacity changes retain the newest points and preserve monotonic serials.

Rendering decimates using a serial-based stride so the same physical samples
remain selected as the ring rotates. Corners and endpoints are preserved,
vertices are split into fading bands for sparse Normal scenes, and global/per-
trail budgets limit work. Dense Normal-mode scenes use one bounded gradient
current path per trail instead of a disjoint colour-wide `Path2D`. App trail
quality rises slowly during cheap frames and falls quickly
when render cost exceeds its target. The renderer also prunes reusable colour
groups to colours present in the current world and ignores stale trails without
a live body, so repeated recolouring and scene replacement cannot grow that
cache.

## Graphs

The graph dock shows:

- energy: kinetic, potential, total;
- momentum: magnitude, x/y components, and angular momentum;
- phase space: x-vx or y-vy for the selected body.

`App.recordGraphSample()` records every time-series family regardless of which
one is displayed, so switching modes does not create gaps. Sampling cadence is
capped in simulation time from the visible window and maximum point budget.
Mutual-gravity energy is computed through a live-state revision cache shared by
graph sampling and the status-bar drift readout. Physics, edits, direct drags,
rewind, culling, and whole-world replacement invalidate the revision; camera,
selection, pointer-preview, and unchanged paused frames retain the result.

`TimeSeries` keeps named channel arrays with a logical head index. Expired
history advances the head in O(1); backing arrays are compacted only in blocks.
It retains a bounded time window and hard point cap, updates an equal-time
sample in place, clears on backward time, rejects non-finite samples, and lets
legend clicks hide channels. Rendering uses binary search to find the visible
range and smooths only shrinking y-axis bounds. Reduced motion snaps the range.

`PhasePlot` stores bounded time/x/vx/y/vy tuples, compacts in blocks, draws one
axis pair in a square region, and marks the latest point. Selecting a different
body immediately clears the previous phase trajectory and seeds the new body's
current state, even while paused. Its timestamps let rewind truncate future
phase points in the same way as the energy and momentum series.

The graph dock supports live following, scroll-back, unmodified-wheel zoom,
pan, reset, legend toggles, and a resizable splitter. Modified wheel events are
reserved for document-level page-zoom suppression. The dock avoids redrawing
unchanged data unless autoscale easing
is still active. Empty, undersized, or all-hidden plots cancel easing, and the
retained draw signature includes the live palette revision so a theme/accent
change repaints a paused graph exactly once.

## DOM control system

`ui/dom.ts` supplies the common construction and behavior layer:

- `el` creates an element, assigns text/classes/attributes, and appends
  children without templating.
- `button`, `slider`, numeric/text edits, checkbox, segmented control, colour
  editor, section, and half-row return `{ root, refresh? }` controls.
- sliders map a fixed internal range to linear, logarithmic, or blended
  linear/logarithmic values; a zero-preserving log option gives `0` its own
  track stop before a configurable positive floor. Friction uses that mapping
  from exact `0` through `0.01..10`, while the toolbar Speed control uses a
  60% logarithmic blend so ordinary rates are less compressed. Paired
  numeric input allows exact edits and commit/revert behavior.
- `RefreshGroup` polls controls and optionally culls scrolled-out refresh work.
- `wireTabs` and `refreshTabs` implement the roving-focus ARIA tab pattern with
  Left/Right wrapping and Home/End navigation.
- `splitterDrag` handles pointer capture, constraints, and commit callbacks and
  exposes a focusable `separator` with orientation and current/minimum/maximum
  values. Arrow keys resize by 10 CSS px, Shift+Arrow by 32 px, and Home/End
  select the limits. A pane revealed after hidden construction resynchronizes
  those values from its laid-out size, and a dynamic maximum stays current as
  the containing layout changes.
- media predicates reuse live `MediaQueryList` objects and safely degrade when
  `matchMedia` is unavailable.
- `ModalFocus` labels the dialog, captures/restores prior focus, traps Tab
  navigation, and keeps focus inside an open overlay.

Buttons derive accessible names from visible labels or tooltips; icon-only
buttons receive an explicit `aria-label`. Toggle buttons expose
`aria-pressed`, and shortcut badges are `aria-hidden` so they do not pollute the
control name. Colour preset groups and segmented controls expose their selected
state instead of relying on a CSS class. Icon markup comes from the internal
constant `ICONS` table, not user input.

## Panels and overlays

### Persistent panels

- **Toolbar:** playback, rewind/step/reset, speed, editable clock, undo/redo,
  clear, fit/auto-fit, library, settings, and FPS. Running state reports the
  playback frame rate. A paused unchanged canvas says `Idle`; zoom, pan, hover,
  and edit redraws report the cadence of actual canvas paints, never the
  intentional 20 Hz paused wake timer. The play toggle exposes
  `aria-pressed` and changes its accessible name between Start and Pause.
- **Palette:** grouped tool buttons, programmatic pressed state, visually shown
  but accessibility-hidden shortcut badges, and tool descriptions.
- **Hint bar:** active gesture hint plus current time, body/contact counts,
  Normal-mode trail-quality factor when it is meaningfully away from `1x`,
  active Performance quality label, exact `dE` or approximate `~dE`, and
  pointer coordinates where appropriate. Performance mode suppresses both
  trail drawing and the saved Normal-mode trail-factor readout.
- **Graph dock:** graph mode, view controls, canvas rendering, legend hit
  testing, splitter, and contextual gesture hint.
- **Inspector:** object/world/view editing described above.

`main.ts` adds a lightweight panel for the physics/render overload message.

### Modal overlays

- **Library:** category-filtered built-in presets and locally saved scenes.
  A built-in preset's transparent native button covers its entire card, so the
  card loads from any ordinary click or from Enter/Space without displaying a
  separate Load control. Pointer hover and keyboard focus apply the same
  selectable-card treatment. Its independently operable Show more/less control
  is pinned to the bottom-right, has a minimum 24 by 24 CSS px target, and
  exposes `aria-expanded` and `aria-controls`.
  Saved scenes retain explicit Load, rename, description, download, and delete
  buttons. Category filters expose `aria-pressed` and retain keyboard focus
  across a filtered rerender. Save, rename, description, and delete storage
  failures are caught and shown as toasts; a failed action does not trigger a
  success re-render. The desktop header centres a dedicated rounded Library
  tab switcher between the title and Close action. At the phone breakpoint the
  title and Close action occupy the first row and the full-width tab switcher
  occupies the second, keeping all controls reachable without horizontal
  clipping. Category filters wrap within the dialog.
- **Settings:** appearance, theme/accent/font, accessibility, interaction,
  adaptive resolution, performance mode, culling, help, and tour access. Accent
  swatches are full-bleed colour discs whose focus and selected rings sit around
  the fill. They form a named pressed-state group and restore focus after their
  DOM is rebuilt. Each custom-colour removal action is a separate sibling
  button with a target of at least 24 by 24 CSS px rather than nested
  interactive content.
- **Help:** getting-started steps, device-appropriate shortcut reference, and a
  production link to `THIRD_PARTY_NOTICES.txt` for MathLive and OpenDyslexic
  licensing. The notice opens in a separate `noopener` tab so following it
  cannot navigate the live in-memory scene away.
- **Formula guide:** variables, operators, functions, logic, math-editor help,
  and recipe cards with explicit `Add <recipe>` buttons.

Clicking an overlay backdrop closes it. Modal focus returns to the prior
element on close. Shortcut handling gives open overlays and the guided tour
priority over simulation commands.

The guided tour is a genuine modal dialog. While it is open, the application
shell is inert, the full-screen tour root intercepts underlying pointer input,
Tab is trapped in the card, and closing restores the opener and its previous
play state. Step changes are announced through a polite live region. Introductory
and progress counts are derived from the responsive set of steps whose targets
are actually visible, rather than from a fixed total.

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
5. Prevents browser defaults only for a command the app actually consumed,
   except for the intentionally global page-zoom suppression in `main.ts`.

The toolbar clock and formula editors also stop key propagation while editing.
Browser page zoom is disabled by the viewport and by global modified-wheel,
gesture, and Ctrl/Cmd zoom-key guards. Unmodified wheels over the simulation
canvas or graph continue to zoom only those views; their custom touch gestures
remain scoped to the canvases.

## Themes and responsive behavior

`theme.ts` defines three named semantic palettes (`dark`, `void`, and `light`)
and exports live colour bindings consumed by canvas renderers. Theme
application updates those bindings, a monotonic palette revision for retained
Canvas consumers, and CSS custom properties. An optional
hex accent derives hot/dark variants. Every palette's `TEXT_FAINT` has at least
4.5:1 contrast against both panel surfaces. Accent application separately
derives `ACCENT_TEXT` at 4.5:1 against panel surfaces, `FOCUS` at 3:1 against
the background and neutral button surfaces, and black-or-white `ACCENT_INK`
and `ACCENT_DARK_INK` at 4.5:1 against their matching fills. Accent-filled
controls use those ink tokens for text and an inset focus stroke while the
outer focus ring contrasts with the surrounding panel. Extreme black, white,
and mid-grey custom accents therefore retain safe normal text, filled-control
ink, and focus cues. Section, guide, preset-category, tour-step, Help, and
active-control text on neutral or tinted surfaces use `ACCENT_TEXT`; raw accent
tokens remain available for fills, borders, and decorative marks. These labels
remain readable with extreme custom accents.
Canvas colour strings are memoized by packed colour/alpha value with a bounded
cache.

Studio mode is an independent presentation layer over the selected base
palette. It adds gradients, layered surface treatments, rounded compact
controls, stronger visible button/card boundaries, a rounded segmented Library
switcher, elevated preset cards, and workspace spacing while leaving the
background, panel, text, grid, semantic, and default accent colours owned by
Void, Dark, or Light. Preset group names and selected Library controls use the
contrast-safe selected accent. Changing the base theme while Studio mode is on
therefore immediately restyles the same Studio layout with that palette.
Accent-colour choices remain circular full-colour discs in every appearance;
selection is shown with an exterior ring rather than reducing the colour fill.
Physics-object colours remain scene controlled. Studio's shared button surface
treatment has lower selector specificity than component variants, so primary,
danger, ghost, swatch, card, and compact-action geometry and states remain
intact.
Dark is the fallback for an absent or invalid stored theme.

The bottom status row renders each item in its own separated segment. It shows
grammatical body, anchor, link, and contact counts, a pulley count when the
scene contains any, the active Performance profile when applicable, energy
drift, and the pointer coordinate on wider screens. Renderer trail quality and
internal physics-step subdivision are not user-facing status items.

The stylesheet owns:

- desktop flex layout, inspector and dock splitters;
- reusable controls and keyboard focus rings;
- formula, inspector, graph, library, settings, help, and tour presentation;
- phone layout at the shared 760 px breakpoint;
- touch-specific removal of irrelevant key badges/hover-only affordances;
- native text selection in Help, the formula guide, and tour reference text,
  while drag-selection remains disabled on direct-manipulation surfaces;
- OpenDyslexic `@font-face` declarations and body class;
- light/dark `color-scheme` synchronization; and
- reduced-motion removal of decorative CSS transitions/animations.

On phones, the inspector becomes a transiently closed drawer with a persistent
handle; its open/closed state does not overwrite the desktop/tablet visibility
preference. The toolbar brand becomes visually hidden but remains the level-one
heading, toolbar content is trimmed/scrollable, and the graph/overlay layout
adapts. Library and Help headers split across two rows, category controls wrap,
Settings font-scale choices use a compact grid, and footer actions wrap rather
than widening their dialogs. Splitter sizes are clamped both while dragging and
while sanitizing stored preferences. Application and open-overlay content stay
within a 320-CSS-pixel viewport at 200% application text scaling.

## Accessibility

Accessibility behavior is part of the implementation contract:

The product requirement that browser page zoom remain disabled is a deliberate
WCAG 1.4.4 exception: restrictive viewport metadata and page-level input
guards prevent native magnification. The persisted application text-size
control and its 200% reflow coverage remain available, but they are not a full
substitute for browser zoom.

- the canvas has an explanatory label;
- the toolbar brand provides the page's level-one heading, including while
  visually hidden on phones;
- icon-only controls receive explicit accessible labels/tooltips and shortcut
  badges are excluded from name computation;
- play state has a state-specific label and `aria-pressed` value;
- Inspector, Library, and formula-guide pages use connected tablists, tabs,
  and tabpanels with roving keyboard focus;
- category filters, segmented choices, and colour swatches expose pressed
  state and preserve focus across rerenders; accent swatches keep their full
  circular colour fill beneath separate focus and selection rings;
- built-in Library cards expose a visually integrated full-card native button,
  show the same card-level selection cue for pointer hover and keyboard focus,
  recipe and saved-scene cards expose explicit actions, and description toggles
  remain separate controls with expansion state and a 24 CSS px target;
- Inspector reopen handles are named buttons and both splitters are keyboard-
  operable ARIA separators with value metadata;
- transient toasts and overload messages are polite live status regions;
- modal overlays are labelled dialogs with trapped and restored focus;
- the guided tour additionally inerts the application shell, blocks underlying
  pointer input, announces step changes, and restores its opener;
- keyboard focus uses a shared `:focus-visible` ring, including compact custom
  controls and range inputs;
- checkboxes retain compact 14 by 14 CSS px native tick boxes inside labelled
  targets that are at least 24 CSS px high;
- mouse-activated non-text controls are blurred to prevent a stale focused
  button/slider from swallowing the next global shortcut, while keyboard
  activation retains focus;
- browser page zoom is suppressed so zoom remains local to the simulation and
  graph, while native text selection remains available in reference content;
- help/hints switch to touch wording where mouse/keyboard actions are
  unavailable;
- reduced motion affects decorative UI/camera/axis movement, not the physical
  simulation itself; and
- the dyslexia-friendly font and font scale are persisted preferences.

Tests protect focus rings, names/states, tab and splitter keyboard behavior,
theme/custom-accent contrast, page-zoom suppression, modal-tour inertness and
focus restoration, device wording, responsive inspector state, Studio swatch
geometry and Library contrast/containment, open-overlay 320 px/200% reflow,
pointer alignment, scene-replacement undo, tour spotlights, and shortcut
ownership. Chromium axe checks cover WCAG A/AA rules at boot and with the
Library open. See [testing and operations](testing-and-operations.md).
