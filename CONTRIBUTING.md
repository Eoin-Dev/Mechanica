# Commit message style

This project's commit messages follow one convention, pulled from the
repo's own history rather than invented in the abstract. The goal: a
reader who wasn't in the room can tell **what changed and why it was
necessary** without opening the diff.

## Subject line

One line, imperative mood, no trailing period. Pack multiple unrelated
areas into one line by joining terse clauses with semicolons — don't
force a generic summary over things that don't share a cause:

```
Fix trail warping and decay; collide linked bodies; UI polish
Rework user dragging for a real lunge with bounded energy; icon and guide-scroll fixes
Add the "Which lands first?" projectile-independence preset
Math editor polish: caret placement, standard notation, stay-in superscript; recipes add on click
```

Quote proper nouns (preset/feature names) exactly as they appear in the
UI. A colon can introduce a list of what "polish" or "rework" means when
the subject alone would be too vague.

## Body: two shapes, pick based on the commit

**Shape A — single cohesive change.** Open with a short prose paragraph
giving the *why* (the misconception, the root cause, the mechanism), then
bullets for the specifics. No section headers needed:

> Two identical balls released together from the same height, one also
> launched sideways at 6 m/s. The intuitive answer is that the one falling
> straight down lands first; in fact gravity acts only downward, so the
> sideways velocity never touches the fall...
>
> - Balls are identical in radius, mass, restitution and friction, so the
>   initial sideways velocity is the only variable on show...

**Shape B — multiple areas in one commit.** Skip the prose lead-in
entirely and go straight into titled sections, one per area, each a
bullet list:

```
Dragging (interact/tools.ts, engine/world.ts, engine/body.ts):
- Grabbed bodies track the cursor EXACTLY...

Drag UX:
- Hide the green velocity handle while a left-drag is active...

UI fixes:
- The "Import .json" button now uses a down-facing arrow-into-tray icon...

Tests (physics.test.ts):
- speedCap clamps every substep...
```

Section headers name the area or file, not a generic label like
"Changes." Common headers seen in this repo: `Trails:`, `Physics:`,
`Bug fixes:`, `UI:`, `Drag UX:`, `Tests:` — sometimes with the relevant
file(s) in parens when that orients the reader faster than prose would.

## Bullet style — this is the part that actually matters

- **Cite the mechanism, not the surface.** "the rod force solver (which
  reads relative velocity, `b.vel - a.vel`)" — not "fixed the drag bug."
- **Name real identifiers.** Constants, function names, file paths:
  `DRAG_VEL_CAP`, `Body.speedCap`, `PROJECTION_PERCENT`. A bullet without
  a concrete anchor is too vague.
- **State the failure mode being fixed**, concretely: "a nearly-still
  mouse could fling a struck body," "a selected spring could outlive
  itself and leave the inspector editing a ghost."
- **Include measured numbers when you have them**, not adjectives:
  "double-pendulum end bob whips to ~10.7 m/s," not "drag feels more
  energetic now." A number is falsifiable; an adjective isn't.
- **One bullet, one idea.** Use " - " (spaced hyphen, not em-dash) mid-bullet
  to attach a consequence or reasoning clause, e.g. "...so a lattice can
  squash yet never tangle through itself."
- **Say what was removed, if anything was.** "removes `safeDragSpeed` and
  the rigid-carry/kinematic-sharing paths" — deletions are as load-bearing
  as additions, and readers need to know old assumptions no longer hold.

## The Tests section

Whenever a commit touches tested code, close with a compressed list of
*what new invariant each test pins* — not test names:

```
Tests: both balls land within a couple of steps of each other, never
diverge in height while airborne, land at the analytic sqrt(2h/g), and
the launched ball's horizontal travel matches v*t (271 passing).
```

Always end with the exact current passing count in parens —
`(271 passing)` — read off the real test run output, never estimated or
rounded.

## Hard rules

- Never add a `Co-Authored-By` trailer.
- Never round or guess the test count — run the suite and read it off
  right before writing the message.
- No emoji, no marketing adjectives ("blazing," "robust," "clean"). If a
  claim can't be backed by a number or a named mechanism, cut it.
- Present the message in a fenced code block so it's a one-click copy
  into `git commit`.
