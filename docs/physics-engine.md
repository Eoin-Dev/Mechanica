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
| Modes | `locked`, `collides`, `noRotation`, and `isAnchor`. |
| Interaction transient | `held` makes the body infinite-mass during direct manipulation; `speedCap` bounds a dragged connected assembly. |
| Solver transient | acceleration, previous position, position-correction totals, contact/spring flags, performance-solver slots, contact mass gain, and prior acceleration samples. |

An anchor is represented by a body because links need the same endpoint shape.
It is always locked, is named `Anchor`, does not participate in mutual gravity,
and is excluded from ordinary body counts. A locked non-anchor can still exert
mutual gravity and collide.

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
multiplier `lambda`, and a warm-start tension estimate `mu`.

`SpringLink` stores `restLength`, authored `stiffness`, authored axial
`damping`, and `tensionOnly`. It also stores effective `kEff`/`cEff` values
prepared for the current step. A tension-only spring is the elastic-string
model: it pulls when stretched and neither pushes nor damps while slack.

Spring force along the endpoint direction is:

```text
extension = distance - restLength
relativeSpeed = (vB - vA) · normal
forceMagnitude = kEff * extension + cEff * relativeSpeed
```

Positive magnitude pulls the endpoints together. A tension-only link rejects
non-positive extension and also rejects a negative combined spring/damper
force, so damping cannot make a closing string push.

## World state and effective settings

`World` owns object collections and these authored physical settings:

- uniform gravity;
- mutual-gravity toggle, point/solid gravity mode, `G`, and softening;
- linear drag, quadratic drag, and global velocity damping;
- integrator, substeps, and iterative-solver passes;
- simulation time.

It also owns transient contacts, step count, divergence names, trail samples,
warm-start caches, packed scratch arrays, and the performance solver.

Performance mode does not overwrite authored settings. The effective getters
produce runtime overrides:

- substeps are capped by `PERF_SUBSTEPS`;
- solver iterations are capped by `PERF_ITERATIONS`;
- the integrator becomes Symplectic Euler.

This distinction ensures exporting a scene still writes the accurate settings
chosen by its author.

## Step preparation

`prepareStep(h)` derives everything that cannot change during one call to
`step()`:

1. Split links into rod and spring arrays.
2. Build the set of linked endpoint pairs that should not collide. Linked
   bodies normally collide; exclusion applies only when natural link length is
   shorter than the sum of radii, where contact and link constraints would be
   permanently contradictory.
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
body. Syntax and compilation are documented in [data, formulas, and
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

## Integrators

`World.integrate()` selects one of three methods for movable bodies. Contact
torque is integrated through body angular velocity; ordinary force accumulation
does not currently generate torque.

### Symplectic Euler

One force evaluation per slice. Velocity is updated from acceleration, then
position from the new velocity. It is first-order, inexpensive, and robust;
performance mode always selects it.

### Velocity Verlet

The default method. It advances position using current velocity/acceleration,
re-evaluates acceleration at the new position, and advances velocity with the
average acceleration. It is second-order and symplectic, giving strong
long-term energy behavior for oscillators and orbits.

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
iterative passes, total correction divided by `h` is added to velocity. This
makes the corrected motion consistent with the final position. The solve exits
early once correction is negligible.

### Performance-mode spring projection

`PerfSolver` packs all movable spring endpoints and spring rows into typed
arrays. Each row stores XPBD compliance `1/(k h²)`, rest length, accumulated
multiplier, capped damping fraction, strain bounds, and one-sidedness.

The stage performs:

1. Several Gauss-Seidel XPBD projection passes.
2. A per-body displacement limit, preventing a constraint correction from
   teleporting a particle through another body.
3. Conversion of displacement into velocity.
4. Axial relative-velocity damping as a bounded fraction, which cannot
   overshoot and reverse the velocity it is damping.
5. A generous hard stretch limit, plus a compression floor for bilateral
   springs. Tension-only springs have no compression floor.
6. Scatter back to live bodies.

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
moving radius before running circle-capsule narrowphase tests.

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
   overlap without changing velocity. Non-rotating movable bodies can use a
   persisted world-space tangential anchor to resist static creep until the
   Coulomb limit is saturated.

Under heavy contact load, the iteration count is capped so manifold count
times iterations stays bounded. Warm starting carries the converged support
impulses between substeps.

The contact cache key is independent of body detection order. Body-wall keys
use a negative wall ID namespace. Cache entries hold `[normal, tangent]` and,
when needed, a static-friction anchor `[x, y]`.

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
- Substeps and iterations are capped.
- application-level adaptive refinement and in-world encounter slicing are
  disabled;
- springs use the packed XPBD projection path;
- spring endpoint contact mass can be increased up to parity with a heavier
  collider, allowing a coarse projected lattice to resist a heavy body;
- per-body linear speed and surface spin speed have a hard ceiling;
- rendering draws springs more simply and omits body spin markers.

The projection also bounds per-substep movement, spring stretch/compression,
and damping fraction. These are catastrophe bounds, not intended material
properties. No blanket damping is added to spring-connected bodies.

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

The application caches `world.energy()` for one rendered frame because mutual
gravity makes it O(n²), and both graph sampling and the status bar may request
it.

## Numerical safeguards and lifecycle invariants

- Deserialized finite numbers are defaulted and clamped before entering solver
  loops; solver iteration counts have strict limits.
- Spring coefficients are stability-clamped in accurate mode.
- Rod/contact solvers exit early after convergence.
- Adaptive slice work, contact work, and performance-mode speeds are bounded.
- `World.sanitize()` runs after a full step. A body with non-finite or extreme
  position/velocity/spin returns to its finite previous position when possible,
  otherwise the origin, then has motion and acceleration cleared and its name
  reported.
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
