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

Performance mode, adaptive resolution, camera/view settings, contacts, caches,
and diagnostics are not scene settings.

## Body documents

Each `bodies` entry maps to `BodyDict`:

| Field | Meaning and load behavior |
| --- | --- |
| `id` | Non-negative integer at most `2^40`; otherwise the constructor's fresh ID is retained. The body counter advances beyond every accepted ID. If an imported body repeats an earlier body ID, the first body keeps it and the later body receives a fresh ID. |
| `name` | String, limited to 200 characters; otherwise `Body <id>`. Anchors are renamed `Anchor`. |
| `pos` | Two finite numbers `[x, y]`; invalid/missing components become zero. |
| `vel` | Two finite numbers `[vx, vy]`; invalid/missing components become zero. |
| `angle` | Finite radians, default zero. |
| `omega` | Finite radians/second, default zero; forced to zero when `no_rotation` is true. |
| `mass` | Finite and at least zero, default `1`. Zero behaves as infinite translational mass. |
| `radius` | Finite and at least `1e-4`, default `0.15`. |
| `restitution` | Finite and clamped to `0..1`, default `0.8`. |
| `friction` | Finite and at least zero, default `0.4`. |
| `const_force` | Two finite force components in newtons, default `[0, 0]`. |
| `locked` | Boolean, default `false`; locked bodies have zero inverse mass/inertia. Other runtime types use the default. |
| `collides` | Boolean, default `true`; other runtime types use the default. |
| `no_rotation` | Optional boolean, default `false`; other runtime types use the default. |
| `is_anchor` | Optional boolean, default `false`; other runtime types use the default. A true value forces `locked` true and the name `Anchor`. |
| `color` | At least three numeric channels. Channels are rounded/clamped to `0..255`; malformed colours use the generated palette colour. |

The loader constructs each body before applying the stored identity and
properties. Colour arrays are copied so bodies never alias the global palette
or each other.

The following live fields are deliberately absent: `held`, `speedCap`,
`softBody`, `touching`, `sprung`, `contactMassGain`, acceleration, previous
position, constraint corrections, performance packing slots/stamps, and prior
acceleration samples. They are interaction, solver scratch, or preset-only
hints and are rebuilt as needed.

## Wall documents

Each `walls` entry maps to `WallDict`:

| Field | Meaning and load behavior |
| --- | --- |
| `id` | Guarded and counter-advancing like body IDs. The first occurrence of an imported wall ID keeps it; later duplicates receive fresh IDs. |
| `name` | String limited to 200 characters; otherwise `Wall <id>`. |
| `a`, `b` | Finite endpoint coordinate pairs; invalid components become zero. |
| `thickness` | Finite and at least `1e-4`, default `0.08`. |
| `restitution` | Clamped to `0..1`, default `0.8`. |
| `friction` | At least zero, default `0.5`. |
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
- Load constructs a field and compiles both sources. A parse/compile error
  stores an error and leaves compiled functions null, so the field is inert
  while its source remains editable.
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
| `phase` | Radians, finite `[-1e6, 1e6]`, default zero. |
| `angle` | Force direction radians, finite `[-1e6, 1e6]`, default zero. |
| `enabled` | Boolean, default true; other runtime types use the default. |

Drivers whose body is missing or immovable are ignored during step
preparation. Deleting a body deletes its drivers; duplicating selected bodies
copies their drivers to the new IDs.

## Deserialization algorithm

`World.fromDict()` is intended to return a usable world for any JSON-compatible
top-level shape:

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
7. Links are separated by class; duplicate IDs within the rod/rope class or
   within the spring class are remapped. Rod and spring counters are separate,
   so the same numeric ID may occur once in each class.
8. Fields and drivers are reconstructed.

`restore(text)` still begins with `JSON.parse`, so syntactically damaged JSON
throws there. `loadScene()` and `uploadScene()` catch that parse failure and
return null to their UI callers.

Unknown properties are ignored. Missing newer fields use defaults. Saving the
loaded world emits the current supported shape.

## Snapshots, undo, and rewind

### Full snapshot

`snapshot(world)` is compact `JSON.stringify(world.toDict())`. `restore()`
parses and delegates to `World.fromDict`. This is the canonical cloning and
object-graph reconstruction mechanism used by undo, reset, rewind keyframes,
time jumps, saves, and tests.

### Undo stack

`UndoStack` stores full snapshot strings:

- it starts with the provided world;
- pushing an identical snapshot is a no-op;
- pushing after undo drops the redo tail;
- history is capped at `UndoStack.LIMIT` entries;
- undo/redo moves an index and restores the selected snapshot;
- `reset(world)` replaces all edit history with one state.

Undo represents committed edits, not each simulation frame. Callers decide
when a continuous interaction commits.

### Rewind buffer

`RewindBuffer` records simulation display frames under byte and frame budgets.
Only six numbers per body normally change during play: x/y position, x/y
velocity, angle, and spin. The clock adds one more number to a dynamic frame.

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
the body count/stride match, and returns a newly constructed world.

Rewind state is session-only and is not written to local storage or scene JSON.

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
| `theme` | `original`, `dark`, `void`, or `light`; default dark when applied. |
| `dyslexic_font` | Boolean body-font preference. |
| `cull` | Boolean runaway-culling preference, default on. |
| `perf_mode` | Boolean performance solver/render preference, default off. |
| `drag_hits_walls` | Boolean kinematic wall-sweep preference, default off. |
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
at 80 characters, and defaulted to `scene` if empty. `sceneExists()` checks the
sanitized key so differently punctuated inputs cannot silently collide.

`saveScene()` writes or overwrites one payload and returns the safe name. A
quota or blocked-storage failure becomes `SceneSaveError` with a user-facing
message. `listScenes()` scans only the scene prefix and sorts names.
`loadScene()` returns null for a missing or syntactically damaged entry without
deleting it.

Storage access needed to check or enumerate saved scenes also translates a
browser rejection into `SceneSaveError`. The library keeps its save action
available but replaces the scene list with an unavailable message. A rejected
payload read is treated like an unusable scene and returns null.

Delete, rename, and description updates also translate rejected storage
operations into `SceneSaveError`. Multi-key operations capture their prior
values and attempt rollback before throwing. Rename performs all
quota-consuming destination writes before removing the source, clears orphaned
destination metadata when the source has no description, and restores the old
keys if any step fails. The library catches these typed failures and reports
their message without re-rendering a partially successful action.

Descriptions are trimmed. An empty description removes metadata; invalid
metadata JSON reads as an empty description.

## File import and export

Export serializes `world.toDict()` with indentation into an
`application/json` blob. The temporary anchor receives a filesystem-safe name:
non-ASCII/punctuation that survived the storage name is folded to underscores,
and a name without ASCII alphanumerics becomes `scene.json`. The object URL is
revoked after a delay so the browser has time to begin reading it.

Import creates a temporary file input accepting JSON, reads the selected file
as text, restores it, and returns `{ world, name }` or null. Cancelling resolves
null. The library then installs the result, resets undo, captures the start,
fits the camera, and closes the overlay.

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

The formula guide uses the same lazy chunk for static markup. If it cannot
load, plain source remains visible.

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
| Oscillators | Mass on a spring; Damping regimes; Driven resonance; Coupled oscillators; Spring pendulum |
| Collisions & Gas | Billiard break; Restitution ladder; Elastic vs inelastic; Gas in a box (50); Gas in a box (200); Brownian motion |
| Projectiles & Friction | Projectile drag race; Friction ramp; Galileo's drop; Which lands first?; Projectile angles; Terminal velocity; Wrecking ball; Chain bridge |
| Soft Bodies | Jelly block; Squishy ball; Trampoline; Soft wheel; Jelly smash |
| Chaos | Butterfly effect; Orbit dance; Sinai billiard; Cyclone |

`CATEGORIES` is derived from first occurrence in the registry and prepends
`All`. The library uses the registry directly for category chips/cards. Preset
descriptions and hints are behavior-bearing content: changing a builder,
registry entry, category, or hint requires updating this table and any affected
physics/application explanation.
