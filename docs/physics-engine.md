# Physics engine

The engine under `web/src/engine/` advances circular rigid bodies, static
capsule walls, distance constraints, springs, drivers, and user-defined force
fields. It has no browser or third-party dependency and is exercised directly
by the headless test suite.

## Conventions and units

- World coordinates use positive x to the right and positive y upward.
- Camera conversion flips y because canvas coordinates increase downward.
- The ordinary scene units are SI: metres, kilograms, seconds, newtons, radians,
  and radians per second.
- `World.gravity` is the positive magnitude of downward acceleration; force
  accumulation subtracts it from y acceleration. A negative value therefore
  acts upward.
- Orbital presets use scaled units with `G = 1`; the equations are unchanged.
- Bodies are uniform discs. Translational inverse mass is zero for locked or
  held bodies. Rotational inertia is `I = m r² / 2`; inverse inertia is also
  zero for locked, held, or `noRotation` bodies.
- Walls are immovable capsules. Their centreline is a segment and their
  collision radius is half `thickness`.

`Vec2` is mutable. Ordinary arithmetic methods allocate a new vector;
`addIp`, `set`, and `setVec` mutate in place for hot loops.

## Physical object model

### Bodies

`Body` holds the visible and physical properties of one disc:

| Group | Fields and meaning |
| --- | --- |
| Identity | Numeric `id` from a monotonic class counter and a user-visible `name`. IDs connect links, drivers, trails, and contact cache entries. |
| Dynamic state | `pos`, `vel`, `angle`, and angular velocity `omega`. |
| Shape/inertia | `radius`, `mass`, derived `invMass`, `inertia`, and `invInertia`. |
| Contact material | `restitution` and `friction`; body colour is visual only. |
| External force | `constForce`, applied in newtons on every force evaluation. |
| Modes | `locked`, `collides`, `noRotation`, `isAnchor`, and `isPulley`. |
| Interaction transient | `held` makes the body infinite-mass during direct manipulation; `kinematicCorrectionRate` carries the pointer-derived rod feedback rate; `speedCap` bounds a dragged connected assembly in Performance mode. |
| Solver transient | acceleration, realised step-average `netForce`, previous position, position-correction totals, contact/spring flags, performance-solver slots, contact mass gain, and prior acceleration samples. |

An anchor is represented by a body because links need the same endpoint shape.
It is always locked, is named `Anchor`, does not participate in mutual gravity,
and is excluded from ordinary body counts. A locked non-anchor can still exert
mutual gravity and collide.

A pulley axle is also body-shaped so it can be selected, serialized, mounted
to a wall endpoint, and referenced by its string. `isPulley` implies anchor,
locked, non-colliding, non-rotating behavior, the fixed `0.22 m` wheel radius,
and the name `Pulley`. It is not an editable material body and cannot be used
as an ordinary rod/spring endpoint.

`noRotation` removes only rotational freedom. Translation and contact friction
remain active, but friction creates no angular acceleration. This lets a disc
model a point-like slider that can remain in limiting equilibrium on a slope.

### Walls and materials

`Wall` stores endpoints `a`/`b`, thickness, restitution, friction, colour,
identity, and name. It has no velocity or inverse mass.

At a contact:

- restitution is the smaller of the two materials' coefficients;
- friction is `sqrt(muA * muB)`;
- wall properties occupy the infinite-mass side of a body-wall manifold.

The inspector offers named body materials (`Custom`, `Rubber`, `Steel`,
`Wood`, `Ice`, `Clay`, and `Superball`) as restitution/friction pairs. They are
UI conveniences, not a separate serialized material type.

### Links

All links reference endpoint `Body` objects directly.

`DistanceLink` represents either:

- a rod (`isRope = false`), a bilateral fixed-distance constraint; or
- an inelastic string (`isRope = true`), a unilateral maximum-distance
  constraint that becomes slack below its length.

It stores natural `length`, XPBD `compliance` in m/N, a per-substep position
multiplier `lambda`, and a warm-start tension estimate `mu`. Its optional
tension-vector display flag is transient and absent from scene JSON.

`SpringLink` stores `restLength`, authored `stiffness`, authored axial
`damping`, and `tensionOnly`. It also stores effective `kEff`/`cEff` values
prepared for the current step and publishes the signed axial force actually
applied by its latest Normal- or Performance-mode solve for diagnostics. A
tension-only spring is the elastic-string model: it pulls when stretched and
neither pushes nor damps while slack.

Spring force along the endpoint direction is:

```text
extension = distance - restLength
relativeSpeed = (vB - vA) · normal
forceMagnitude = kEff * extension + cEff * relativeSpeed
```

Positive magnitude pulls the endpoints together. A tension-only link rejects
non-positive extension and also rejects a negative combined spring/damper
force, so damping cannot make a closing string push.

`PulleyLink` owns two ordinary particle endpoints plus one fixed pulley body.
Its `length` is the complete light-string length: both straight tangent legs
and the wrapped arc. The two contact points move around the finite wheel as
the particles swing. Each leg meets the wheel tangentially, the wrapped arc is
included in the length constraint, and both particle gradients share one
non-negative multiplier. The result is equal tension on both legs, no pushing
while slack, and free particle motion rather than a hidden rail constraint.
`guideAOffset`/`guideBOffset` retain the intended wrap topology and the
wall-aligned creation geometry; `wrapSweep` retains which direction the string
passes around the wheel. Optional wall-mount identity follows a chosen wall
endpoint without making either particle part of the wall.

The pulley wheel remains absent from ordinary body/body collision generation.
Its own two string particles instead use a dedicated zero-restitution stop at
`wheel radius + particle radius`. Position recovery cannot become velocity;
normal velocity and acceleration into the active stop are removed while
tangential motion remains free. The pulley length projection treats a stopped
endpoint with an active-set tangent gradient, so the string and stop do not
fight or inject energy when a rising particle reaches the wheel. Each solver
substep also sweeps the particle centre from its starting position against the
wheel expanded by the particle radius. A fast particle is clamped at the first
impact even when both sampled endpoints lie outside the wheel, preventing it
from tunnelling through the disc and switching string branches.

## World state and effective settings

`World` owns object collections and these authored physical settings:

- uniform gravity;
- mutual-gravity toggle, point/solid gravity mode, `G`, and softening;
- linear drag, quadratic drag, and global velocity damping;
- integrator, substeps, and iterative-solver passes;
- simulation time.

It also owns transient contacts, step count, divergence names, trail samples,
warm-start caches, packed scratch arrays, and the performance solver.

Performance mode does not overwrite authored settings. Its transient adaptive
level is also absent from scene JSON. Effective substep/iteration caps for
levels 0 through 3 are respectively `2/4`, `2/3`, `1/2`, and `1/1`; the
integrator is Symplectic Euler at every level. The browser starts the setting
at level 1, raises it when measured physics/render load cannot sustain smooth
play, and relaxes after sustained headroom. A headless caller can set
`World.performanceLevel` explicitly, so the engine performs a fixed,
deterministic algorithm for each chosen level.

This distinction ensures exporting a scene still writes the accurate settings
chosen by its author.

## Step preparation

`prepareStep(h)` derives everything that cannot change during one call to
`step()`:

1. Synchronize mounted pulley axles with their wall endpoints, then split links
   into rod, spring, and pulley arrays.
2. Build the set of linked endpoint pairs that should not collide. Linked
   bodies normally collide; exclusion applies only to a `DistanceLink` whose
   natural length is shorter than the sum of endpoint radii, where its rigid
   distance constraint and contact constraint would be permanently
   contradictory. Springs and tension-only elastic strings remain collidable
   at every rest length in both solver modes.
3. Prepare effective spring coefficients.
4. Mark spring endpoints for adaptive-resolution exclusions and performance
   contact-mass behavior.
5. Pack movable bodies and their inverse masses for repeated force evaluation.
6. Prune obsolete trail sample anchors when their map has clearly outgrown the
   live mover set.
7. Resolve enabled drivers to live movable bodies and precompute direction
   components divided by mass.
8. Store the per-step contact-static object, including collision exclusions.

The world assumes object lists and editable physical properties do not change
inside a step. The application and controls make edits between step calls.

### Step input contract

`World.step(dt)` accepts finite, non-negative seconds. A negative, `NaN`, or
infinite value throws `RangeError` before state changes. Zero is a strict
no-op. A positive value is also a strict no-op when its effective substep `h`
is too small for the solver's squared-timestep terms: `h == 0`, `h² == 0`, or
`1/h²` is non-finite. A strict no-op leaves physical state, diagnostics,
caches, scratch state, `time`, and `stepCount` unchanged.

## Force accumulation

Every force evaluation clears body acceleration and accumulates terms in a
fixed order.

### Constant force, uniform gravity, and drag

For each movable body:

```text
acceleration = constForce / mass + (0, -gravity)
dragForce = -(dragLinear + dragQuadratic * |velocity|) * velocity
acceleration += dragForce / mass
```

Thus the quadratic term has magnitude proportional to speed squared. Global
damping is separate: after constraint/contact resolution it multiplies linear
and angular velocity by `max(0, 1 - globalDamping * h)` per substep.

### Mutual gravity

Mutual gravity is an O(n²) symmetric pair pass over non-anchor bodies. Body
position, mass, radius, movability, and accumulated acceleration are packed
into reusable typed arrays. Packing removes repeated getters/object hops while
preserving pair order and therefore bit-for-bit accumulation order.

With point gravity, the acceleration scale uses softened inverse distance:

```text
d² = |rB - rA|² + softening²
scale = G / (d² * sqrt(d²))
aA += scale * massB * (rB - rA)
aB -= scale * massA * (rB - rA)
```

With solid-disc gravity, squared separation is floored at the square of the
sum of radii before softening is applied. Inside an overlap the resulting pull
falls linearly toward zero at coincident centres instead of creating a
point-mass singularity. The energy calculation uses a matching continuous
interior potential.

Locked non-anchor bodies pull movable bodies but do not receive acceleration.
Anchors neither pull nor are pulled.

### Drivers

A `Driver` addresses one body ID and applies

```text
F(t) = amplitude * sin(2*pi*frequency*t + phase)
```

along the configured angle. Step preparation resolves the body, rejects
disabled/missing/immovable targets, and precomputes the unit direction divided
by mass. Only the sinusoidal phase changes during force evaluations.

### User force fields

Each enabled `ForceField` has compiled x/y functions of
`x, y, vx, vy, t, m, r`. The world reuses one environment object, refills it
for each movable body, evaluates both components as newtons, divides by mass,
and adds finite results. A singular or throwing sample is skipped for that
body. Compiling a field is atomic: both components are installed together, or
both compiled functions become null while the intact sources and error remain
available for repair. Parsing, compilation, and math formatting share bounded
source/token/AST/depth/argument limits. Their exact values and language syntax
are documented in [data, formulas, and
scenes](data-formulas-scenes.md#force-field-expression-language).

### Spring forces

In the accurate solver, every spring applies its effective Hooke/damper force
after ordinary and gravitational acceleration. Effective coefficients are
bounded against explicit integration stability:

```text
w = invMassA + invMassB
kLimit = 1 / (referenceH² * w)
cLimit = 0.5 / (referenceH * w)
```

The reference step is at least the authored base substep
`World.clampDt / substeps`; adaptive frame subdivision cannot make the same
scene's effective spring change with machine load. Authored values remain
available for serialization.

Performance mode bypasses force-form springs entirely and leaves `kEff` and
`cEff` at their non-negative authored values for the projection stage.

## Rod and rope force solve

Rods and taut inelastic strings receive an acceleration-level constraint
force before integration. For a distance constraint `C`, the solve enforces
zero second derivative:

```text
d²C/dt² = normal · (accB - accA) + |relativeTangentialVelocity|² / distance = 0
```

Rows are packed into reusable arrays. The previous force multiplier is warm
started, then a small fixed number of Gauss-Seidel sweeps propagates tension
through chains. A rope multiplier is clamped so it can pull but never push; a
slack rope clears its warm start.

Solving tension as acceleration is essential for energy behavior. A
position-only pendulum correction would delete radial velocity gained during
each substep and systematically damp the swing.

### Pulley-string force solve

For a taut pulley string the constraint is the sum of two tangent lengths and
the live wrapped arc:

```text
C = tangentLengthA + tangentLengthB + wheelRadius*abs(wrapSweep) - length
```

The contact angles are recomputed from each particle, wheel centre, wheel
radius, and retained wrap direction. The constraint gradients are the unit
directions of the two straight legs. One warm-started, non-negative multiplier
applies `-T*gradient` to each endpoint, so the force magnitude `T` is identical
on both sides even when masses differ. The acceleration solve includes the
finite-wheel curvature term for a moving tangent; when the current path is
shorter than `length`, the multiplier is cleared and the string is slack.

## Integrators

`World.integrate()` selects one of three methods for movable bodies. Contact
torque is integrated through body angular velocity; ordinary force accumulation
does not currently generate torque.

### Symplectic Euler

One force evaluation per slice. Velocity is updated from acceleration, then
position from the new velocity. It is first-order, inexpensive, and robust;
performance mode always selects it.

### Velocity Verlet

The default method is a generalized predictor-corrector form that remains
second-order when acceleration depends on velocity, as it does for drag,
damped springs, and velocity-dependent custom fields:

1. Evaluate acceleration at the initial position, velocity, and time.
2. Kick to half-step velocity, retain that velocity in reusable packed scratch,
   and drift position through the full slice.
3. Install the full-step velocity predictor `v0 + h*a0`, then evaluate the
   second acceleration at the new position and time.
4. Finish with the trapezoidal correction
   `v1 = vHalf + (h/2)*a1`.

For forces independent of velocity, the predictor does not affect the second
evaluation and the arithmetic reduces to the standard kick-drift-kick path,
preserving its symplectic long-term energy behavior. The half-velocity scratch
grows geometrically and is reused across calls and adaptive slices.

### RK4

Four derivative evaluations over packed position/velocity scratch arrays. It
is fourth-order for smooth short-term trajectories but is not symplectic, so
long orbital runs may drift even though local error is small.

## Adaptive close-encounter integration

### Application-level subdivision

`World.subdivisionNeed(dt, maxQ)` estimates the curved-path deviation
`|a| dt² / 8` and compares it with 4% of body radius, floored for point-like
bodies. It returns the equal subdivision factor required to stay under the
tolerance. Immovable, contact-supported, and spring-supported bodies are
ignored because their raw acceleration is largely cancelled by a later
constraint and does not represent free-flight curvature.

### In-substep encounter slices

For mutual-gravity worlds outside performance mode, integration can march
through one substep with varying slices. The target limits relative
acceleration change per slice (`ENCOUNTER_ANGLE`). Each body retains the
previous acceleration sample needed to estimate the change rate.

The slice floor limits refinement, and `SLICE_WORK_BUDGET` bounds work in units
that include body and pair-force evaluations plus integrator cost. A dense
world may receive no extra slices and falls back to authored substep
resolution. Remaining work never uses timing measurements.

Adaptive slices can write intermediate body positions into `World.trace` when
the application requests a world-space spacing. This preserves a visually
smooth U-turn that happened inside one externally visible step.

## Post-integration constraints

### Rod/rope XPBD position pass

After integration, rods and taut ropes remove their small remaining length
error using XPBD. For each row:

```text
alpha = compliance / h²
deltaLambda = (-constraint - alpha*lambda) /
              (invMassA + invMassB + alpha)
```

Position corrections are mass-weighted and accumulated per body. After the
iterative passes, total correction divided by `h` is normally added to
velocity, making integration corrections consistent with the final position.
When a rigid component contains a directly held endpoint, its corrections use
the controller's reduced pointer-time correction rate instead. This prevents a
once-per-display-frame hand displacement from being reinterpreted as motion
that occurred in one much shorter solver substep. The rate propagates through
the rigid component in O(rows); untouched constraints retain the ordinary fast
path. The solve exits early once correction is negligible.

Pulley strings run an analogous one-sided XPBD pass on their summed live path.
The two corrections are mass-weighted along the current tangent directions and
fed back into particle velocity. Performance mode retains this same physical
constraint at every quality level. Because one row is only two fixed-wheel
tangent calculations, it keeps at least eight nonlinear refinement passes even
when the general Performance iteration budget falls further, including while a
particle is at the wheel stop; tiered substeps, contact work, rendering
simplification, and global speed guards still apply.

### Performance-mode spring projection

`PerfSolver` packs all movable spring endpoints and spring rows into typed
arrays. Each row stores XPBD compliance `1/(k h²)`, rest length, accumulated
multiplier, capped damping fraction, strain bounds, and one-sidedness.

The stage performs:

1. Several Gauss-Seidel XPBD projection passes.
2. Strain recovery toward a generous maximum length and, for bilateral
   springs, a compression floor. Relative velocity that worsens an active
   violation is removed; tension-only springs have no compression floor.
3. One final per-body limit on the combined displacement from all projection
   and strain-recovery work, preventing any later correction from bypassing
   the movement cap and teleporting a particle through another body. An
   extreme strain violation therefore recovers over several substeps rather
   than overriding this cap.
4. Conversion of the retained displacement into velocity, followed by axial
   relative-velocity damping as a bounded fraction, which cannot
   overshoot and reverse the velocity it is damping.
5. Scatter back to live bodies.

The solver also exposes each row's existing signed XPBD reaction
`-lambda / h^2` for the optional axial-force overlay. This adds no projection
pass and allocates no per-row objects.

This path trades force-model accuracy for unconditional spring stability at
coarse resolution.

## Collision detection

`solveContacts()` creates transient manifolds, resolves them together, exposes
a simplified `Contact` snapshot for diagnostics, and stores warm-start data for
the next substep.

### Broadphase

Only bodies with `collides` and at least one movable side can create a body
pair. The broadphase derives a size split once per world step:

- typical bodies enter a uniform spatial hash whose cell size follows the
  largest small-body diameter;
- each occupied cell is compared with itself and four forward neighbors, so
  pairs are considered once;
- unusually large bodies are tested separately so a planet among dust does
  not make every grid cell planet-sized.

Body-wall detection computes an expanded wall bounding box from the largest
moving radius before running circle-capsule narrowphase tests. Performance
profiles use an x-sorted mover sweep when the body-wall product is large.

### Narrowphase

- Circle-circle contact uses centre distance, summed radii, and a stable
  fallback normal for coincident centres.
- Circle-wall contact projects the body centre to the closest point on the
  segment and tests against `body.radius + wall.thickness/2`.
- Each manifold stores normal, contact point, penetration, material
  coefficients, contact arms, effective normal/tangent masses, restitution
  target, accumulated impulses, static-friction anchor, and a stable pair key.

The manifold normal points from body A toward body B. For a wall, B is null
and the normal points from the body into the infinite-mass side.

### Impact and resting solve

The response has four stages:

1. **Warm start.** Reapply cached normal/tangent impulses so a resting stack
   begins close to equilibrium.
2. **Impact propagation.** Closing contacts faster than `RESTING_SPEED` receive
   exact pairwise restitution impulses over several sweeps. This carries an
   impact through a touching chain without treating its interior contacts as
   a permanently separating velocity bias.
3. **Sequential velocity impulses.** Iterative accumulated normal impulses are
   clamped non-negative. Tangential impulses are clamped to Coulomb magnitude
   `mu * normalImpulse`. Applying the tangent impulse at the contact arms
   changes spin, so rolling emerges rather than being prescribed.
4. **Position and static-friction passes.** Split-impulse projection removes
   overlap without changing velocity. The solver then builds an O(contacts)
   graph of pressed, unsaturated contacts between non-rotating movable bodies.
   Walls and structurally immovable bodies are fixed roots; a transiently
   `held` body is deliberately not a root. Only components connected to a root
   may use persisted world-space tangential anchors to resist static creep.
   Unsupported contacts rebase their anchor every substep, and a newly
   supported contact rebases once before pinning, so a freely translating pair
   retains its common motion rather than being pinned to the world.

Under heavy contact load, the iteration count is capped so manifold count
times iterations stays bounded. Warm starting carries the converged support
impulses between substeps.

At maximum approximation, contacts retain broadphase/narrowphase, restitution,
one normal-impulse sweep, and one penetration pass so objects still separate
and bounce. Tangential friction, rotational response, warm-start persistence,
and the static-support graph are omitted. This intentionally makes ramps slide
instead of roll and can make piles softer, but removes work that is invisible
in particle-gas scenes.

The contact cache key is independent of body detection order. Body-wall keys
use a negative wall ID namespace. Each typed `ContactCacheEntry` holds normal
and tangent impulses, anchor coordinates, whether an anchor exists, and
whether that anchor was connected to fixed support. The support bit prevents
an anchor recorded during a different support state from being reused.

## Kinematic wall clearing

Held bodies are infinite-mass. A normal body-wall manifold would therefore
have two immovable sides and cannot correct a directly written position. When
the “dragged bodies hit walls” preference is enabled, the interaction layer
uses two collision helpers instead:

- `clearOfWalls` pushes a disc out of overlapping capsules, preferring the side
  indicated by its previous legal position.
- `sweepClearOfWalls` marches toward the cursor in steps no larger than half a
  radius, resolving each step and bounding total work. If the target is too far
  away it shortens travel for the frame rather than coarsening enough to tunnel.

## Performance mode

Performance mode is applied to every stepping path through
`App.applySolverMode`/`safeStep`. It changes the following effective behavior:

- Symplectic Euler replaces the authored integrator.
- Substeps, constraint passes, impact passes, contact work, and iterations
  decrease progressively across four transient approximation levels.
- application-level adaptive refinement and in-world encounter slicing are
  disabled;
- springs use the packed XPBD projection path;
- spring endpoint contact mass can be increased up to parity with a heavier
  collider, allowing a coarse projected lattice to resist a heavy body;
- large mutual-gravity systems use a reusable uniform-grid approximation. The
  own and eight neighboring cells remain pairwise-exact; farther occupied
  cells act through aggregate mass and centre of mass. Threshold/grid pairs
  for levels 1 through 3 are `384/16`, `256/12`, and `128/8`;
- unlinked, force-free resting bodies sleep after 45 still contact frames at
  level 2 or 20 at level 3. Edits, mode/quality changes, and impacts wake them;
- per-body linear speed and surface spin speed have a hard ceiling;
- levels 2 and 3 use a `1/60 s` application quantum instead of `1/120 s`;
- maximum level drops friction, angular motion, contact persistence and some
  analytical rendering, and records rewind state at eight samples per
  simulated second.

The projection also bounds per-substep movement, spring stretch/compression,
and damping fraction. These are catastrophe bounds, not intended material
properties. No blanket damping is added to spring-connected bodies.

Energy diagnostics remain exact in Normal mode. Performance mode samples a
deterministic bounded subset of mutual-gravity pairs for drift readouts; the
`~dE` prefix marks that approximation. This diagnostic never feeds forces.

## Diagnostics

`World` exposes:

- kinetic, uniform-gravity, spring, and mutual-gravity potential energy;
- total linear momentum;
- centre of mass;
- total angular momentum about the centre of mass, including body spin;
- latest contact positions/normals/impulses;
- current divergence names;
- body lookup/removal and batched removal helpers;
- subdivision need for the application scheduler.

Energy uses `kEff` for spring potential so it reports the spring actually
applied by the solver. Locked/held bodies are excluded from dynamic energy and
momentum. Mutual-gravity energy follows the same softened and solid-interior
model as the force.

The application caches `world.energy()` by physical-state mutation revision
because mutual gravity makes it O(n²). Graph sampling and the status bar share
the cached result, and unchanged frames retain it until the world mutates.

## Numerical safeguards and lifecycle invariants

- Untrusted body and wall data uses shared bounds before entering solver loops:
  coordinates `[-1e6, 1e6]`, velocity components `[-1e7, 1e7]`, radius and
  wall thickness `[1e-4, 1e6]`, friction `[0, 1e6]`, and constant-force
  components `[-1e9, 1e9]`. Zero mass remains an immovable zero; any other
  finite mass is clamped to `[1e-9, 1e12]`. Driver amplitude uses the same
  force bound. Imported body angles and driver phase/direction are normalized
  to `[-pi, pi)`, and imported spin is limited so `|omega| * radius <= 1e7`.
  Internal snapshot restoration selects the guarded preserve-angle path so
  undo and rewind reproduce finite accumulated body/driver angles exactly.
- `World.fromDict()` bounds raw collections before constructing objects:
  2,000 bodies, 2,000 walls, 10,000 links, 64 fields, and 2,000 drivers. It
  throws typed `SceneLimitError` above a limit while retaining total guarded
  reconstruction for malformed shapes within the limits. Solver iteration
  counts also have strict limits.
- Spring coefficients are stability-clamped in accurate mode.
- Rod/contact solvers exit early after convergence.
- Adaptive slice work, contact work, and performance-mode speeds are bounded.
- `World.sanitize()` runs after a full step. Position and velocity must remain
  within their import bounds; angle and spin must be finite; surface spin must
  remain at most `1e7`. A failing body returns to its bounded finite previous
  position when possible, otherwise the origin. Velocity, spin, and
  acceleration are cleared, a finite angle is normalized (otherwise reset to
  zero), and the body's name is reported.
- `escapedBodies()` identifies non-finite bodies or bodies beyond a generous
  scene-centred distance that are still moving outward. Locked, anchored, and
  held bodies are protected. `App` optionally removes the result in one batch.
- Removing bodies also removes links and drivers that address them. Batched
  removal keeps culling and multi-delete linear.
- Object IDs are never intentionally reused. Trail maps, driver references,
  link reconstruction, selection structure keys, and warm-start caches rely on
  stable identity.
- The world list and editable physical properties must remain unchanged during
  one `step()` call.

## Numerical tradeoffs

- The engine models discs and capsule walls, not arbitrary rigid polygons.
- Ordinary body-body motion is discrete. Direct pointer motion optionally uses
  a sweep, but the general solver is not a continuous-collision detector.
- Explicit springs may be softened by the effective stiffness/damping clamp.
  Several springs meeting at one node can still be more demanding than the
  per-spring limit; performance mode exists as the unconditional fallback.
- RK4 offers higher local order but not symplectic long-term behavior.
- App/world adaptive refinement improves violent curved motion but is bounded;
  sufficiently large scenes fall back to their authored coarse step.
- Contact iteration is deliberately capped under dense load. Warm starting and
  split projection favor stable real-time behavior over an exact global solve.
- Performance mode changes physical fidelity and should not be used when the
  goal is measurement-quality comparison with the accurate solver.
- Position projection preserves constraints and penetration bounds but is not
  itself a force law; velocity feedback is used where momentum consistency is
  necessary.

These tradeoffs are explicit and covered by analytic, invariant, stress, and
long-run tests. See [testing and operations](testing-and-operations.md).
