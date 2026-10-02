# Data, formulas, and scenes

Mechanica has two persisted data domains:

- a portable scene JSON document produced by `World.toDict()`; and
- browser-local application preferences produced by `App.saveSettings()`.

Scene JSON contains physical model state and can be downloaded, imported, or
stored in local storage. Preferences describe one browser's appearance,
layout, interaction, and accuracy choices and never travel with a scene.

## Scene JSON overview

`WorldDict` has this top-level shape:

```json
{
  "settings": {
    "gravity": 9.81,
    "mutual_gravity": false,
    "point_gravity": false,
    "G": 1,
    "softening": 0.01,
    "drag_linear": 0,
    "drag_quadratic": 0,
    "global_damping": 0,
    "integrator": "Velocity Verlet",
    "substeps": 4,
    "iterations": 8,
    "time": 0
  },
  "bodies": [],
  "walls": [],
  "links": [],
  "fields": [],
  "drivers": []
}
```

The document has no explicit version field. Compatibility is achieved by
treating every field as optional at runtime, applying defaults to absent or
invalid values, ignoring unsupported object entries, and using stable snake-
case field names shared with the earlier desktop application.

### World settings

| JSON field | Runtime property | Default and accepted value |
| --- | --- | --- |
| `gravity` | `World.gravity` | `9.81`, finite, clamped to `[-1e6, 1e6]`. Positive acts downward. |
| `mutual_gravity` | `mutualGravity` | Boolean, default `false`; enables all-pairs gravity. Non-booleans use the default. |
| `point_gravity` | `pointGravity` | Boolean, default `false`; selects solid-disc interior behavior when false. Non-booleans use the default. |
| `G` | `G` | `1`, finite, clamped to `[-1e12, 1e12]`. |
| `softening` | `softening` | `0.01`, finite, clamped to `[0, 1e6]`. |
| `drag_linear` | `dragLinear` | `0`, finite, clamped to `[0, 1e9]`. |
| `drag_quadratic` | `dragQuadratic` | `0`, finite, clamped to `[0, 1e9]`. |
| `global_damping` | `globalDamping` | `0`, finite, clamped to `[0, 1e9]`. |
| `integrator` | `integrator` | One of `Velocity Verlet`, `Symplectic Euler`, or `RK4`; otherwise Verlet. |
| `substeps` | `substeps` | Integer `1..64`, default `4`. |
| `iterations` | `iterations` | Integer `1..64`, default `8`. |
| `time` | `time` | `0`, finite, clamped to `[-1e12, 1e12]`. |

Performance mode, its transient adaptive level/sleep state, adaptive
resolution, camera/view settings, contacts, caches, and diagnostics are not
scene settings.

## Body documents

Each `bodies` entry maps to `BodyDict`:

| Field | Meaning and load behavior |
| --- | --- |
| `id` | Non-negative integer at most `2^40`; otherwise the constructor's fresh ID is retained. The body counter advances beyond every accepted ID. If an imported body repeats an earlier body ID, the first body keeps it and the later body receives a fresh ID. |
| `name` | String, limited to 200 characters; otherwise `Body <id>`. Anchors are renamed `Anchor`. |
| `pos` | Two finite numbers `[x, y]`, each clamped to `[-1e6, 1e6]`; invalid/missing components become zero. |
| `vel` | Two finite numbers `[vx, vy]`, each clamped to `[-1e7, 1e7]`; invalid/missing components become zero. |
| `angle` | Finite radians normalized to `[-pi, pi)` on untrusted load, default zero. Internal snapshot reconstruction preserves finite accumulated angles exactly. |
| `omega` | Finite radians/second, default zero, clamped so `abs(omega) * radius <= 1e7`; forced to zero when `no_rotation` is true. |
| `mass` | Finite, default `1`. Exact zero is preserved as infinite translational mass; every other value is clamped to `1e-9..1e12`. |
| `radius` | Finite `1e-4..1e6`, default `0.15`. |
| `restitution` | Finite and clamped to `0..1`, default `0.8`. |
| `friction` | Finite `0..1e6`, default `0.4`. |
| `const_force` | Two finite force components in newtons, each clamped to `[-1e9, 1e9]`, default `[0, 0]`. |
| `locked` | Boolean, default `false`; locked bodies have zero inverse mass/inertia. Other runtime types use the default. |
| `collides` | Boolean, default `true`; other runtime types use the default. |
| `no_rotation` | Optional boolean, default `false`; other runtime types use the default. |
| `is_anchor` | Optional boolean, default `false`; other runtime types use the default. A true value forces `locked` true and the name `Anchor`. |
| `is_pulley` | Optional boolean, default `false`. A true value identifies an internal pulley axle and forces `is_anchor`, `locked`, and `no_rotation` true; `collides` false; radius `0.22`; zero velocity, spin, and constant force; and the name `Pulley`. An axle without a valid `PulleyLink` is pruned after link loading. |
| `is_pivot` | Optional internal compatibility flag, default `false`. A true non-pulley value represents an Anchor attached as a fixed rod support: it forces anchor/locked/non-colliding identity, clears motion and constant force, and is presented to the user as `Anchor`. |
| `is_rod_endpoint` | Optional internal flag, default `false`. It marks the two hidden, non-colliding, non-rotating solver coordinates owned by a standalone rod. It is ignored on pulley axles and rod anchors; orphaned endpoints are pruned after link reconstruction. |
| `rod_id` | Optional non-negative `DistanceLink` ID or `null`, default `null`. After all links load, only a reference to a live bilateral rod survives; invalid/orphaned/self-endpoint references are released. |
| `rod_position` | Finite affine coordinate along the referenced rod, clamped to `0..1`, default `0.5`; zero is endpoint A and one is endpoint B. |
| `color` | At least three numeric channels. Channels are rounded/clamped to `0..255`; malformed colours use the generated palette colour. |

The loader constructs each body before applying the stored identity and
properties. Colour arrays are copied so bodies never alias the global palette
or each other.

The following live fields are deliberately absent: `held`, `speedCap`,
`softBody`, `touching`, `sprung`, `contactMassGain`, acceleration, previous
position, constraint corrections, performance packing slots/stamps, and prior
acceleration samples. The per-particle free-body-diagram toggle and slope
reference are view state and are absent too. These values are interaction,
analysis, solver scratch, or preset-only hints and are rebuilt as needed.
The realised `netForce` and optional immutable named-force `forceSnapshot`
are also absent. Restoring a scene starts with a current-force preview until
another recorded step supplies a consistent force interval.

## Wall documents

Each `walls` entry maps to `WallDict`:

| Field | Meaning and load behavior |
| --- | --- |
| `id` | Guarded and counter-advancing like body IDs. The first occurrence of an imported wall ID keeps it; later duplicates receive fresh IDs. |
| `name` | String limited to 200 characters; otherwise `Wall <id>`. |
| `a`, `b` | Finite endpoint coordinate pairs, each component clamped to `[-1e6, 1e6]`; invalid components become zero. |
| `thickness` | Finite `1e-4..1e6`, default `0.08`. |
| `restitution` | Clamped to `0..1`, default `0.8`. |
| `friction` | Finite `0..1e6`, default `0.5`. |
| `color` | Validated RGB triple, otherwise the wall grey. |

Walls have no dynamic or transient serialized state.

## Link documents

Links use a tagged union and refer to bodies by ID.

### Rod or inelastic string

```json
{
  "type": "rod",
  "id": 1,
  "a": 1,
  "b": 2,
  "length": 1.5,
  "is_rope": false,
  "compliance": 0
}
```

| Field | Behavior |
| --- | --- |
| `a`, `b` | Endpoint body IDs. A link is skipped if either endpoint is absent or both IDs are the same. |
| `length` | Natural/fixed distance, finite and clamped to `0..1e6`; missing/invalid uses current endpoint separation. |
| `is_rope` | Boolean, default false. False is a bilateral rod; true is a tension-only maximum-distance constraint. Other runtime types use the default. |
| `compliance` | XPBD compliance, finite and clamped to `0..1e9`, default zero. |
| `origin_at_a` | Boolean, default true. It chooses whether the Inspector's editable attachment distance is measured from A or B; the physical affine `rod_position` remains measured from A. |
| `id` | Guarded ID; advances the `DistanceLink` counter. The first rod/rope with an imported ID keeps it and later duplicates in this link class receive fresh IDs. |

Per-substep position `lambda` and warm-start force multiplier `mu` are not
serialized.

### Spring or elastic string

```json
{
  "type": "spring",
  "id": 1,
  "a": 1,
  "b": 2,
  "rest_length": 1.5,
  "stiffness": 20,
  "damping": 0,
  "tension_only": false
}
```

| Field | Behavior |
| --- | --- |
| `rest_length` | Finite `0..1e6`; invalid uses endpoint separation. |
| `stiffness` | Authored N/m, finite `0..1e9`, default `20`. |
| `damping` | Authored axial Ns/m, finite `0..1e9`, default zero. |
| `tension_only` | Boolean, default false. True gives elastic-string behavior; other runtime types use the default. |
| `id`, `a`, `b` | Same identity/reference rules as rods, using the separate spring counter. A rod and spring may share the same numeric ID because link identity includes its class; duplicates within the spring class are remapped. |

Effective stability-clamped `kEff` and `cEff` are recalculated and are not
serialized.
Modulus entry is an alternate way to set existing `stiffness`: `λ/rest_length`
for a positive natural length. The scene schema remains unchanged, and
save/load, reset, undo and redo retain that stiffness and natural length.
Zero natural lengths remain valid imports; their modulus entry is unavailable
until a positive natural length is set.

### Inextensible pulley string

```json
{
  "type": "pulley",
  "id": 1,
  "a": 1,
  "b": 2,
  "pulley": 3,
  "length": 3.2,
  "compliance": 0,
  "guide_a": [-0.22, 0],
  "guide_b": [0.22, 0],
  "wrap_sweep": -3.141592653589793,
  "wall_id": null,
  "wall_end": 0,
  "wall_normal_sign": 1
}
```

| Field | Behavior |
| --- | --- |
| `a`, `b` | Two distinct ordinary, non-anchor particle IDs. Both must resolve and must differ from the pulley ID. A valid route normalizes both to non-rotating radius-`0.16` point particles for its lifetime; their serialized radius is otherwise ignored. Missing, anchor, pulley, or repeated endpoints skip the link. |
| `pulley` | ID of a body whose guarded `is_pulley` value is true. A missing, ordinary, endpoint, or already-claimed axle skips the link; one axle owns exactly one routed string. |
| `length` | Total light-string length, including both live tangent legs and the finite wrapped arc; finite and clamped to `0..1e6`. Invalid data uses the current guide-leg lengths plus a half circumference. |
| `compliance` | XPBD compliance, finite and clamped to `0..1e9`, default zero. The UI-created pulley keeps this zero for an inextensible string. |
| `guide_a`, `guide_b` | Guarded fallback/topology offsets from the axle, each component clamped to `[-1e6, 1e6]`. Live tangent points are recomputed from current particle positions. |
| `wrap_sweep` | Guarded signed wrap direction in `[-2*pi, 2*pi]`, default `-pi`; live arc magnitude follows the tangent contacts while the sign retains which way the string passes around the wheel. |
| `wall_id` | Optional mounted-wall ID or `null`. A missing wall detaches the axle without deleting the assembly. |
| `wall_end` | Mounted endpoint index `0` or `1`, default `0`. |
| `wall_normal_sign` | Surface-side sign normalized to `-1` or `1`, default `1`. |
| `id` | Guarded ID with a separate `PulleyLink` counter and duplicate-remapping namespace. |

Force warm-start `mu`, position `lambda`, dynamic tangent contacts, safe sweep
samples, active wheel-stop state, and routing-half-plane state are transient
and are not serialized. The latter topology is derived from the persisted
guide offsets and signed wrap direction.

## Force-field and driver documents

### Force fields

```json
{
  "name": "Wind",
  "fx": "-0.5*vx",
  "fy": "0",
  "enabled": true
}
```

- `name` is a string limited to 80 characters, default `Field`.
- `fx`/`fy` are expression source strings. They are not truncated because
  truncation could produce a different valid formula.
- `enabled` is boolean and defaults true; other runtime types use the default.
- Load constructs a field and compiles both sources into temporary functions.
  They are installed together only after both succeed. Any parse, complexity,
  compile, stack, or probe failure is reported as `ExprError`, stores an
  actionable error, clears both compiled axes, and leaves the complete source
  strings editable. A stale function from one axis can therefore never remain
  active beside a failed axis.
- Compiled closures and error text are runtime state, not JSON.

### Drivers

```json
{
  "body_id": 3,
  "amplitude": 5,
  "frequency": 1,
  "phase": 0,
  "angle": 0,
  "enabled": true
}
```

| Field | Load behavior |
| --- | --- |
| `body_id` | Guarded object ID; invalid becomes `-1`, which resolves to no body and is inert. |
| `amplitude` | Newtons, finite `[-1e9, 1e9]`, default `5`. |
| `frequency` | Hz, finite `[0, 1e6]`, default `1`. |
| `phase` | Radians normalized to `[-pi, pi)` on untrusted load, default zero. Internal snapshot reconstruction preserves finite values exactly. |
| `angle` | Force direction radians normalized to `[-pi, pi)` on untrusted load, default zero. Internal snapshot reconstruction preserves finite values exactly. |
| `enabled` | Boolean, default true; other runtime types use the default. |

Drivers whose body is missing or immovable are ignored during step
preparation. Deleting a body deletes its drivers; duplicating selected bodies
copies their drivers to the new IDs.

## Deserialization algorithm

`World.fromDict()` is intended to return a usable world for any JSON-compatible
top-level shape within the collection budgets. It throws `SceneLimitError`
when a collection exceeds its resource cap:

| Collection | Maximum entries |
| --- | ---: |
| Bodies | 2,000 |
| Walls | 2,000 |
| Links | 10,000 |
| Force fields | 64 |
| Drivers | 2,000 |

The loader checks all five array lengths before constructing objects or
advancing identity counters, so a resource-limit failure is atomic. For an
input within those limits:

1. A non-object top level becomes an empty partial object.
2. A non-object settings value becomes an empty settings object.
3. Each scalar setting is type-checked and defaulted/range-checked; booleans
   are never inferred through JavaScript truthiness, and the integrator is
   checked against the supported list.
4. Each collection must be an array; entries that are not objects are skipped.
5. Bodies and walls are reconstructed independently. Within each collection,
   the first occurrence of an accepted ID retains it and later duplicates are
   assigned fresh IDs.
6. A body-ID map is built after de-duplication, then valid link records are
   resolved to direct endpoint object references. Ambiguous references to a
   repeated imported body ID therefore resolve deterministically to the first
   body that carried it; drivers retain the same target ID.
7. Links are separated by class; duplicate IDs within the rod/rope, spring, or
   pulley-string class are remapped. Their counters are separate, so the same
   numeric ID may occur once in each class. Ordinary links cannot target an
   internal pulley body. Pulley records require two ordinary particles and one
   distinct valid axle marked `is_pulley`; the first valid record claims that
   axle and later shared-axle records are skipped.
8. Rod attachments are resolved only to a live bilateral rod that does not own
   the attaching body as an endpoint. Orphaned hidden rod endpoints and internal
   pulley bodies not owned by a surviving pulley string are pruned. Links to
   pruned endpoints are removed too. Pulley particles cannot be hidden rod
   endpoints. Valid wall mounts are synchronized and missing/degenerate mounts
   detach.
9. Fields and drivers are reconstructed. A driver aimed at an internal pulley
   axle is skipped because the axle has no editable motion or force state.

`restore(text)` begins with `JSON.parse` and requires a non-array object with at
least one scene member (`settings`, `bodies`, `walls`, `links`, `fields`, or
`drivers`), then uses the untrusted import path. Syntactically damaged or
unrelated JSON throws; recognized scene shapes within the budgets still produce
a usable world. Imported coordinates, velocities,
sizes, nonzero mass, friction, force, angular surface speed, and angles use the
central limits documented above. Runtime sanitization reuses the coordinate,
velocity, and angular surface-speed ceilings and also contains non-finite
angles.

`restoreSnapshot(text)` is reserved for strings produced by the running
application. It uses the same shape and finite-number guards but preserves
body angles and driver phase/direction exactly rather than normalizing them.
It also bypasses external collection-count ceilings: live creation/duplication
can exceed an import budget, while history has its own byte and entry limits.
Undo, redo, rewind keyframes, reset, and time-jump copies use this trusted path;
saved and uploaded scene data always use `restore()`.

Unknown properties are ignored. Missing newer fields use defaults. Saving the
loaded world emits the current supported shape.

## Snapshots, undo, and rewind

### Full snapshot

`snapshot(world)` is compact `JSON.stringify(world.toDict())`. `restore()` is
the normalized untrusted scene boundary; `restoreSnapshot()` is the exact
internal reconstruction boundary. Both delegate to `World.fromDict`, but only
the trusted path requests angle preservation and disables external collection
limits. Other shape, scalar, and topology guards still apply.

### Undo stack

`UndoStack` stores full snapshot strings under two limits: 120 entries and an
estimated 48,000,000 UTF-16 bytes. `App.beginEdit()` captures the live state
before an immediate mutation or the first update of a continuous gesture;
`commitEdit()` captures the result and records both through
`pushTransition(before, after)`. This preserves the exact evolved state before
an edit even when physics has run since the preceding history entry.

- Store operations return `unchanged`, `stored`, or `too-large`.
- An identical post-edit snapshot is `unchanged`.
- Pushing after undo removes the redo tail and its accounted bytes.
- Oldest states are evicted until both limits are satisfied.
- An individual snapshot, or an exact before/after transition, that cannot fit
  resets the stack to the current post-edit state and returns `too-large`; no
  partial undo boundary remains.
- Undo/redo moves the index and reconstructs with `restoreSnapshot()`.
- `reset(world)` replaces all edit history with one state and is used for
  startup initialization.

Presets, saved scenes, uploaded worlds, and scene clearing are normal edit
transactions. Startup `initializePreset()` is the only replacement route that
intentionally clears undo history.

### Rewind buffer

`RewindBuffer` records simulation display frames under a 48,000,000-byte
budget and a 3,000-frame ceiling. `push()` returns `stored` or `too-large`.
Ten numbers per body normally change during play: x/y position, x/y velocity,
angle, spin, x/y acceleration, and x/y realised net force. The clock and world
step count add two more numbers to a dynamic frame. Each frame also owns the
enabled particles' immutable named-force intervals and copied contact data,
including contact directions, normal/tangential impulses and body/wall IDs.
Rewinding restores the recorded interval, including an impact that has already
ended, instead of replacing it with a different current-force calculation.
These records never retain live bodies or pooled contact objects. Their arrays,
source strings and a conservative object allowance count against the same
byte budget; frames without recorded forces or contacts allocate no analysis
arrays. Saved scene JSON remains unchanged.

`structuralDigest()` folds every other serialized world value into a fast
32-bit digest: world settings except time, body identity/properties, walls,
link topology and properties, fields, and drivers. A differing digest requires
a full snapshot keyframe. A matching digest is not treated as proof of
equality: the same shared structural traversal compares every value with the
captured keyframe structure. Only an exact match permits a `Float64Array`
dynamic delta against the latest keyframe.

Trimming removes oldest frames until the frame/byte budgets are respected and
reclaims a keyframe once no surviving frame references it. `back()` removes the
current frame, restores the preceding keyframe, overlays its dynamic array when
the body count/stride match, prunes future unreferenced keyframes, and returns a
newly constructed world. If an individual keyframe or dynamic frame cannot fit,
the buffer clears and reports `too-large`; if a keyframe/delta pair cannot fit,
it retains the latest state as a fresh keyframe when that snapshot fits.

Rewind state is session-only and is not written to local storage or scene JSON.
Energy, momentum, distance, velocity, phase-portrait, event-table, and trail
samples carry simulation time or are explicitly rebased/truncated when the
world rewinds.

## Browser settings

Preferences use local-storage key `mechanica.settings`. `sanitizeSettings()`
drops unknown or wrongly typed values so a stale/corrupt preference cannot
prevent startup.

| Setting | Meaning and accepted value |
| --- | --- |
| `adaptive_dt` | Boolean; application-level state-derived refinement. Default on. |
| `inspector_visible` | Boolean; persisted inspector visibility. |
| `inspector_w` | Finite number clamped to `240..620` CSS pixels. |
| `dock_h` | Finite number clamped to `110..1200` CSS pixels. |
| `tour_done` | Boolean first-visit marker. |
| `theme` | Base palette: `dark`, `void`, or `light`; default dark when applied. A legacy `studio` value without an explicit `studio_mode` is read as Dark with Studio enabled. |
| `studio_mode` | Boolean presentation layer over the selected base palette; default off. |
| `dyslexic_font` | Boolean body-font preference. |
| `cull` | Boolean runaway-culling preference, default on. |
| `perf_mode` | Boolean adaptive performance solver/render preference, default off. The chosen runtime level is not persisted. |
| `drag_hits_walls` | Boolean kinematic wall-sweep preference, default on. An explicit saved false remains off. |
| `new_scene_gravity` | Finite number clamped to `0..100`, default `9.8` when absent. Clear applies it to the newly created world; it does not override gravity in presets, imports, saved scenes, reset, or the current world. |
| `accent` | `#rrggbb` string. Absent uses the theme default. |
| `custom_accents` | Up to six valid `#rrggbb` strings. |
| `font_scale` | Finite number clamped to `0.9..1.2`. |

Settings writes are best-effort; failure leaves the current in-memory
preference active for the session. View overlays such as grid, trails, labels,
vectors, follow, and graph mode are not included in this settings object.

## Saved scene storage

The snapshot module uses two namespaces:

```text
mechanica.scene.<safe name>      portable scene JSON
mechanica.scenemeta.<safe name> metadata JSON such as description
```

Keeping metadata separate preserves scene payload compatibility.

Scene names are normalized to NFC, trimmed, limited to Unicode letters and
digits plus literal space, underscore, and hyphen, whitespace-collapsed, capped
at 80 Unicode code points without splitting an astral character, and defaulted
to `scene` if empty. The shared `normalizeSceneName()` also supplies the Library
form's stored-name preview. `sceneExists()` checks the
sanitized key so differently punctuated inputs cannot silently collide.

`saveScene()` checks the loader's collection limits with
`assertSceneCollectionLimits()` and the serialized UTF-8 payload's 10 MiB
ceiling before writing or overwriting a payload. A rejected scene raises
`SceneSaveError` and leaves any existing save intact. Successful saves return
the safe name. Quick save chooses a millisecond-resolution name such as
`Scene 2026-08-04 123456-789`; if that sanitized key already exists it probes
`-2`, `-3`, and later suffixes rather than overwriting it. A quota or
blocked-storage failure becomes `SceneSaveError` with a user-facing message.
`listScenes()` scans only the scene prefix and sorts names.

Scene reads use the `SceneReadResult` discriminated union rather than nullable
success. Its statuses are `loaded`, `cancelled`, `missing`, `invalid`,
`too-large`, and `storage-error`; successful results carry `world` and `name`,
and resource/storage failures carry a message. A missing or damaged stored
entry is left in place. Cancellation is silent, while malformed data,
collection limits, and rejected storage access receive distinct feedback.

Storage access needed to check or enumerate saved scenes translates a browser
rejection into `SceneSaveError`. The library keeps its save action available
but replaces the scene list with an unavailable message. A rejected payload
read returns `storage-error` rather than being conflated with a missing scene.

Delete, rename, and description updates also translate rejected storage
operations into `SceneSaveError`. Multi-key operations capture their prior
values and attempt rollback before throwing. Rename performs all
quota-consuming destination writes before removing the source, clears orphaned
destination metadata when the source has no description, and restores the old
keys if any step fails. The Library's themed save/rename/description/delete
forms catch these typed failures, show inline messages and retain the draft
without re-rendering a partially successful action. Saving an existing
normalized name focuses Cancel and requires a second, explicit Replace scene action; changing
the name clears that pending confirmation. Rename never replaces another
saved scene. Empty name fields receive correction guidance. Descriptions use
a multiline editor, and deletion initially focuses Cancel. Escape cancels
the editor while keeping the Library open; closing the Library discards its
editor draft. Switching Library sections retains the draft for that opening.

The editor reads the actual field value at submission, including updates that
did not emit an input event; such a change clears replacement confirmation.
Opening rename, description or delete captures a `SavedSceneVersion` containing
the exact stored payload and metadata. Replacement confirmation captures the
version being offered for overwrite. These versions are passed to the storage
mutations, which compare the current saved values before writing. Changes or
deletion during editing produce inline conflict guidance, retain the draft and
preserve the newer data. Cancel and reopen to review that data before editing
again. Opening a description from a stale card reads its current text; actions
on a missing scene refresh the list with feedback.

`savedSceneVersion()` translates rejected reads into `SceneSaveError`. The
optional version argument on save, rename, description and delete keeps direct
storage callers usable without an editor. Comparison uses exact strings rather
than a hash or persisted schema change. It checks changes observed before the
write; local storage does not supply an atomic compare-and-set transaction
across tabs. An unchanged-name rename returns `null` when its source is missing.

Descriptions are trimmed. An empty description removes metadata; invalid
metadata JSON reads as an empty description.

## Tab recovery

`TabRecovery` stores one compact scene snapshot under `mechanica.tab-recovery`
in `sessionStorage`, independently of named scenes in `localStorage`. It
survives refreshes of that tab; closing a tab may discard it. New independent
tabs have their own checkpoints. Duplicating a tab may copy its initial session
storage, after which the two tabs remain independent.

Startup validates the checkpoint through the untrusted `restore()` boundary,
restores it paused, fits the view, and makes the replacement undoable. Undo
history, graph samples, camera/view choices, and the earlier reset baseline are
not included; the recovered clock becomes the new reset baseline.

Committed edits reuse their existing serialized snapshot. Pause, step/rewind,
and world replacements also checkpoint. Playback saves at five-second intervals;
automatic event pauses and solver failure stops checkpoint their final state.
Visibility loss and page exit capture the latest live scene. Unchanged writes
are skipped. A one-million-character ceiling bounds the checkpoint's storage
cost; unavailable/quota-limited storage and oversized scenes report a single
session warning and retain the previous successfully saved checkpoint.
Corrupt stored data is retained until a later successful write replaces it.
Named saves and downloads remain the durable way to keep a scene.

## File import and export

Export serializes `world.toDict()` with indentation into an
`application/json` blob. It checks the same collection limits and the actual
indented payload's 10 MiB size before offering the download; the Library reports
any `SceneSaveError`. The temporary anchor receives a filesystem-safe name:
non-ASCII/punctuation that survived the storage name is folded to underscores,
and a name without ASCII alphanumerics becomes `scene.json`. The object URL is
revoked after a delay so the browser has time to begin reading it.

Import creates a temporary file input accepting JSON and rejects a file larger
than 10 MiB from its byte-reported `File.size` before calling `text()`. While a
file is being read the Library's instance-level import state disables both the
current action and any replacement action created by a tab rerender. Closing
the Library aborts that request and releases the action for reopening. The
picker settles cancellation immediately and releases its handlers; a pending
`File.text()` read cannot be interrupted, but its late text is discarded before
parsing. Request identity prevents old results, errors, or cleanup from
affecting a later scene or import. Picker-opening failures report a retryable
error and release the action. Parsing uses the untrusted `restore()` path and
returns `SceneReadResult`; cancelling returns `cancelled` without feedback.
Invalid JSON and collection-limit failures leave the live
world and its history unchanged. A `loaded` result is installed as an undoable
world replacement, captures that world's clock as the reset/time-jump
baseline, fits the camera, and closes the overlay. Saved-scene loads follow the
same atomic replacement rule.
Valid JSON without a scene member is also rejected instead of opening an empty
world. The low-level `World.fromDict()` remains tolerant of arbitrary shapes.

### Recorded graph CSV

Graph **Data** is a detached, browser-local snapshot of the active graph's
retained samples, taken after sampling its current state. Its CSV is separate
from scene JSON: graph history is transient and is not saved or imported with a
scene. Export uses a fixed `mechanica-<graph>.csv` filename and a UTF-8
`text/csv` blob; no submission service or network upload is involved.

The first column is `time_s`, the simulation clock. Energy columns are KE, PE
and total in joules; momentum columns are magnitude, px and py in kg m/s plus
angular momentum about the centre of mass in kg m²/s. Displacement has sx/sy in
metres, distance has accumulated travel in metres, velocity has speed/vx/vy in
m/s, and phase has world x/vx/y/vy. Every retained channel is included, even if
hidden in the plot. CSV numbers preserve the stored floating-point value,
whereas the table preview uses twelve significant figures.

Particle exports append numeric `body_id`. Kinematics additionally append
`reference_time_s`, `reference_x_m` and `reference_y_m` for the selection/Clear
origin. Names are displayed as text in the modal and are excluded from CSV and
filenames. Headers quote commas, quotes and line breaks; rows use CRLF endings.
The serializer rejects non-finite values and mismatched row lengths before
allocating a download. Empty data cannot be downloaded. Anchor cleanup and
delayed object-URL revocation cover successful and rejected clicks, and browser
errors leave the snapshot available for retry.

## Force-field expression language

The expression language is a restricted Python-like numeric language. User
text is tokenized and parsed into an AST; it is never passed to `eval` or
`Function`.

### Variables and constants

| Name | Value for the body currently being evaluated |
| --- | --- |
| `x`, `y` | Position in metres. |
| `vx`, `vy` | Velocity in metres/second. |
| `t` | Simulation time in seconds. |
| `m` | Body mass in kilograms. |
| `r` | Distance from the world origin, `sqrt(x² + y²)`. |
| `pi`, `tau` | π and 2π. |
| `e` | Euler's number. |
| `g` | Constant `9.81`; independent of the world's editable gravity. |

Identifier tables have no JavaScript prototype, so names such as
`constructor` or `toString` are not accidentally treated as language symbols.

### Functions

| Arity | Functions |
| --- | --- |
| One argument | `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sqrt`, `exp`, `log`, `abs`, `sign`, `floor`, `ceil` |
| Two arguments | `atan2`, `hypot` |
| One or more | `min`, `max` |

Names and arity are validated while parsing. There are no property accesses,
arrays, assignments, strings, loops, or calls to arbitrary functions.

### Operators and semantics

From lowest to highest precedence, the grammar is:

```text
ternary    := or_expr ('if' or_expr 'else' ternary)?
or_expr    := and_expr ('or' and_expr)*
and_expr   := not_expr ('and' not_expr)*
not_expr   := 'not' not_expr | comparison
comparison := arith (('<'|'<='|'>'|'>='|'=='|'!=') arith)*
arith      := term (('+'|'-') term)*
term       := unary (('*'|'/'|'//'|'%') unary)*
unary      := ('+'|'-') unary | power
power      := atom ('**' unary)?
atom       := number | name | call | '(' ternary ')'
```

`^` in source is normalized to `**`. Power is right-associative and binds more
tightly than unary minus, so `-x^2` is `-(x^2)` and `2^-3` is valid.

- comparisons may chain and yield numeric `1.0`/`0.0`;
- `and`/`or` short-circuit and return an operand, using zero as false;
- `not` returns one for zero and zero otherwise;
- `a if condition else b` evaluates one branch;
- `//` is floor division;
- `%` follows the divisor's sign, matching Python;
- finite power operands that overflow raise `ExprError`;
- ordinary division/domain singularities may produce non-finite results, which
  the force application layer skips per body.

Compilation folds the AST into nested closures. It probes the result once at a
representative environment so obvious NaN/domain failures surface while the
user is editing. Successful functions are called directly from the force loop.

### Expression resource budgets

Parsing, compilation, source formatting, and MathLive conversion share the
same exported limits:

| Resource | Maximum |
| --- | ---: |
| Source characters | 4,096 |
| Tokens | 2,048 |
| AST nodes | 1,024 |
| AST depth | 128 |
| Arguments in one function call | 128 |

Limits reject the complete expression with `ExprError`; source is never
truncated into potentially different valid physics. AST validation uses an
iterative budget walk before recursive compilation or formatting, and parser,
compiler, and probe stack/complexity failures are converted to actionable
`ExprError` messages. `ForceField.compile()` installs `fx` and `fy` atomically
only after both compile successfully; any failure clears both closures while
retaining both source strings and the error.

## Source text and typeset math

Scene JSON always stores source text. LaTeX exists only inside a MathLive
editor or rendered guide element.

`mathfmt.ts` provides:

- `parseSource`/AST reuse from the compiler;
- `sourceToLatex()` for supported source-to-editor rendering;
- a dedicated small LaTeX lexer/parser for MathLive output;
- `latexToAst()` and `latexToSource()` for commit;
- `astToSource()` for precedence-preserving normalized text; and
- `isMathRenderable()` to decide whether typeset editing is lossless.

The renderable subset is numbers without exponential notation, variables,
constants, unary minus, arithmetic/power, and supported function calls.
Comparisons, logic, `not`, ternary, floor division, and modulo remain in the
plain text editor. Scientific-notation literals also remain text because
rewriting a parsed floating-point number as mantissa × 10^n is not guaranteed
to preserve the exact value.

LaTeX output uses fractions, radicals, subscripts for `vx`/`vy`, standard
trigonometric/log notation, `e` powers for `exp`, absolute bars, floor/ceiling
brackets, and implicit multiplication only where unambiguous. The reverse
parser validates variables, functions, and arity against the same compiler
tables, so a successful conversion emits source the engine accepts.

`mathEdit()` starts with a fully usable text input, dynamically imports
MathLive and its CSS/fonts, and swaps in a `MathfieldElement` only after loading.
It preserves focus, keeps invalid in-progress LaTeX visible, commits on blur or
Enter, reverts on Escape, and stops global shortcuts while editing. Load or
attachment failure leaves the text editor in place.
Upgrade waits while the interim text input is focused or contains a rejected
edit, and detached rows are not upgraded. Both conversion failures and compiler
rejections retain the edited formula and expose `aria-invalid`. A failed lazy
load can be retried when another editor is opened.
Enter/Escape are intercepted before MathLive's inner handler. Escape restores
the stored source before blur; an unchanged text-field blur does not commit a
rounded display value.

The formula guide uses the same lazy chunk for static markup. If it cannot
load, plain source remains visible and a later guide opening can retry. Detached
guide content is not typeset after loading completes.
Typeset formula containers are named and keyboard-focusable so long expressions
can be scrolled. Phone reference rows stack code above its explanation, and
recipe descriptions are not line-clamped.

### Force-field recipes

The guide resolves each recipe with `recipeSources()` both for its preview and
when its Add button is activated. Anti-gravity captures the world's current
uniform gravity as an ordinary numeric `Fy = m*(value)` source. Its saved field
does not track later gravity edits; users update Fy when changing that setting.
The language constant `g` stays fixed at 9.81 and existing scenes keep their
stored sources and meaning. Exponential notation uses the normal text fallback.

Recipe fields add to gravity and every other active force. Setting world gravity
to zero and disabling other fields and forces isolates the examples. Linear drag
uses `F = -0.5*v`; quadratic drag uses
`F = -0.3*hypot(vx,vy)*v`, so its magnitude is proportional to total speed squared
and its direction opposes velocity in a stationary medium. Both apply forces,
so acceleration depends on body mass. The spring-to-centre equilibrium is the
origin only when uniform gravity is zero. The softened gravity well approaches
inverse-square behaviour far from the origin; the vortex applies torque about
the origin without applying spin torque to a body's centre. Smooth radial and
sigmoid weights have gradual transitions rather than exact on/off regions.

## Preset system

Each `Preset` stores name, category, educational description, builder, and
optional view hints:

- initial zoom and centre;
- trails and velocity vectors;
- continuous auto-fit; and
- energy, momentum, or phase graph.

Calling `build()` invokes the builder and then the shared solver cost cap. Every
builder returns a fresh `World`; randomized layouts use a local seeded
Mulberry32 generator, so repeated builds are deterministic and do not consume
global `Math.random` state.

Helper builders add bodies, anchors, boxes, pendulum chains, soft lattices, and
orbital base worlds. `sceneWork()` estimates body, pair-gravity, link, field,
and contact-like work. `capSolverCost()` reduces preset substeps/iterations
when needed, never below its stability floor, and records the authored
substeps transiently so the inspector can explain the cap. The cap is applied
centrally so new presets cannot bypass it.

The registry is ordered for the library and currently contains these groups:

| Category | Presets |
| --- | --- |
| Gravity & Orbits | Earth & Moon; Kepler ellipse; Inner planets; Binary stars; Gravity slingshot; Newton's cannon; Trojan asteroids |
| Three-Body Problem | Sun, Earth & Moon; Three-body figure-8; Lagrange's triangle; Choreography: moth; Choreography: butterfly; Pythagorean three-body |
| Pendulums | Simple pendulum; Double pendulum; Triple pendulum; Swinging rope; Newton's cradle; Coupled pendulums |
| Oscillators | Mass on a spring; Elastic string release; Damping regimes; Driven resonance; Coupled oscillators; Spring pendulum |
| Collisions & Gas | Billiard break; Restitution ladder; Elastic vs inelastic; Direct collision; Gas in a box (50); Gas in a box (200); Brownian motion |
| Projectiles & Friction | Projectile drag race; Friction ramp; Pulley on an incline; Galileo's drop; Which lands first?; Projectile angles; Terminal velocity; Wrecking ball; Chain bridge |
| Soft Bodies | Jelly block; Squishy ball; Trampoline; Soft wheel; Jelly smash |
| Chaos | Butterfly effect; Orbit dance; Sinai billiard; Cyclone |

Newton's cannon and Projectile angles overlay several finite-size bodies at
one launch point. Their contact separation affects the comparison, and the
cannon shots also attract each other through mutual gravity. Their descriptions
explain that keeping one projectile at a time gives an isolated trajectory;
the displayed ideal formulas assume the stated isolated/equal-height conditions.

The Friction ramp places three deliberately non-rotating balls 1.5 m apart
along its 25-degree surface. Its friction levels demonstrate fast sliding,
slower sliding, and static holding without rotational motion obscuring the
comparison.

Direct collision isolates two smooth, non-rotating particles in zero gravity:
`mA = 2 kg`, `mB = 3 kg`, `uA = +4 m/s`, `uB = −1 m/s`. Their material
coefficients are `0.6` and `1`, giving contact restitution `0.6`. Momentum
conservation and relative separation speed give `vA = −0.8 m/s` and
`vB = +2.2 m/s`, momentum `5 kg m/s`, kinetic-energy loss `9.6 J` and impulses
`−9.6 N s`/`+9.6 N s`. The actual preset motion is checked at its shipped
Normal-mode settings. It opens momentum and shows velocity vectors in a
stable view anticipating the first impact, with blue A and orange B named
in the description. Fit/auto-fit remain available for longer exploration.
The Elastic vs inelastic description states common velocity after
impact; zero restitution creates no persistent attachment.

Elastic string release isolates a non-rotating, non-colliding `2 kg` load on
one light tension-only string, with `l = 2 m`, modulus `λ = 39.2 N`, zero
damping and `g = 9.8 m/s²`. It starts at natural length, opens the energy
graph and enables auto-fit so the expanding string and load stay in view.
RK4 with eight substeps retains the ideal model: equilibrium extension
is `mg/k = 1 m`, and the first maximum extension after release is `2mg/k = 2 m`.
The description's numerical values and the actual turning-point motion/energy
are tested. Selecting its string opens the modulus/Hooke card.

Brownian motion starts with its motion-trail hint disabled so the dense gas is
clear and inexpensive on first load. Pulley on an incline mounts a fixed axle
at the upper endpoint of a sloped wall, places a `2 kg` non-rotating particle
on the slope and a `1.1 kg` hanging particle on the other leg, and joins them
with one inextensible `PulleyLink`; both particles retain ordinary friction and
restitution behavior.

The Trampoline has lower anchors at the wall bases and upper anchors exactly
on both wall-top endpoints. Two maximum-stiffness side springs run from those
upper anchors to the bed shoulders with damping `250 N s/m` (half the editor
maximum); their natural lengths are measured only after the bed relaxation, so
they begin unstretched. The gymnast keeps centre `(0, 2.6)` with radius
`0.36 m`.

Sun, Earth & Moon uses nested barycentric initial conditions. The dynamic Sun
and Earth-Moon pair receive equal-and-opposite outer-orbit momentum; Earth and
Moon receive equal-and-opposite internal-orbit momentum. The total centre of
mass and linear momentum therefore start at zero while the Moon remains inside
half of Earth's Hill radius.

`CATEGORIES` is derived from first occurrence in the registry and prepends
`All`. The library uses the registry directly for category chips/cards. Preset
descriptions and hints are behavior-bearing content: changing a builder,
registry entry, category, or hint requires updating this table and any affected
physics/application explanation.
Optional readonly `Preset.topics` metadata supplies truthful visible Library
study labels and search terms; it does not alter scene physics or JSON. The
Library prepares a headless text index including SHM/SUVAT expansions, keeps
registry order and applies the selected category after query normalization.
The tour derives its example count from the registry instead of a stored total.
