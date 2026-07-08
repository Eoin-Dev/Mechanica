"""Collision detection and response.

Broadphase: uniform spatial hash rebuilt per substep. Bodies of typical size
are binned into cells (one cell each, cell = largest small-body diameter) and
pairs are found by scanning each cell against itself and its four forward
neighbours, so no pair is tested twice. The few bodies much larger than the
median (planets among dust, the Brownian grain) would bloat the cells, so
they are tested by brute force instead.

Narrowphase: circle-circle and circle-capsule (wall) tests.

Response: iterated sequential impulses with accumulated-impulse clamping
(the Box2D scheme). Restitution enters as a velocity bias captured before
the solve, so stacked/simultaneous contacts converge to a consistent
solution instead of depending on resolution order. Friction impulses act at
the contact point and produce torque, so rolling emerges naturally.
Penetration is removed afterwards by split-impulse positional projection,
which does not change velocities and therefore cannot inject kinetic energy.
"""
from __future__ import annotations

from math import isfinite

import numpy as np

from mechanica.engine.body import Body, Wall

# Below this approach speed a bounce is treated as perfectly inelastic, which
# stops resting objects from jittering on the floor.
RESTING_SPEED = 0.10
PENETRATION_SLOP = 0.0005   # m of overlap tolerated before projection
PROJECTION_PERCENT = 0.8    # fraction of the remaining overlap removed per pass
POSITION_ITERATIONS = 3     # projection passes per substep (stacks settle)
IMPULSE_EPSILON = 1e-9      # convergence threshold for early exit

# At/above this many colliders, candidate pairs come from one vectorized
# numpy distance test instead of the Python spatial hash.
VEC_MIN_COLLIDERS = 48


class Contact:
    """A resolved contact, kept for visualization/diagnostics."""

    __slots__ = ("px", "py", "nx", "ny", "impulse")

    def __init__(self, px: float, py: float, nx: float, ny: float, impulse: float) -> None:
        self.px, self.py, self.nx, self.ny, self.impulse = px, py, nx, ny, impulse


class _Manifold:
    """One contact point with precomputed effective masses and accumulators.

    The normal (nx, ny) points from body a toward body b; for walls b is None
    and the normal points from the body into the wall (infinite mass side).
    """

    __slots__ = (
        "a", "b", "nx", "ny", "px", "py", "pen", "mu",
        "inv_ma", "inv_mb", "inv_ia", "inv_ib", "inv_m_sum",
        "ra_x_n", "rb_x_n", "k_n", "ra_x_t", "rb_x_t", "k_t",
        "ray", "rax", "rbx", "rby", "target_vn", "pn", "pt", "sep_base",
        "key",
    )

    def __init__(self, a: Body, b: Body | None, nx: float, ny: float,
                 pen: float, px: float, py: float, e: float, mu: float) -> None:
        self.a = a
        self.b = b
        self.nx = nx
        self.ny = ny
        self.px = px
        self.py = py
        self.pen = pen
        self.mu = mu
        inv_ma = a.inv_mass
        inv_ia = a.inv_inertia
        if b is not None:
            inv_mb = b.inv_mass
            inv_ib = b.inv_inertia
        else:
            inv_mb = inv_ib = 0.0
        self.inv_ma, self.inv_mb = inv_ma, inv_mb
        self.inv_ia, self.inv_ib = inv_ia, inv_ib
        self.inv_m_sum = inv_ma + inv_mb

        rax = px - a.pos.x
        ray = py - a.pos.y
        if b is not None:
            rbx = px - b.pos.x
            rby = py - b.pos.y
        else:
            rbx = rby = 0.0
        self.rax, self.ray, self.rbx, self.rby = rax, ray, rbx, rby

        ra_x_n = rax * ny - ray * nx
        rb_x_n = rbx * ny - rby * nx
        self.ra_x_n, self.rb_x_n = ra_x_n, rb_x_n
        self.k_n = self.inv_m_sum + ra_x_n * ra_x_n * inv_ia + rb_x_n * rb_x_n * inv_ib
        tx, ty = -ny, nx
        ra_x_t = rax * ty - ray * tx
        rb_x_t = rbx * ty - rby * tx
        self.ra_x_t, self.rb_x_t = ra_x_t, rb_x_t
        self.k_t = self.inv_m_sum + ra_x_t * ra_x_t * inv_ia + rb_x_t * rb_x_t * inv_ib

        # restitution bias from the pre-solve approach speed
        vn0 = self._normal_velocity()
        self.target_vn = -e * vn0 if vn0 < -RESTING_SPEED else 0.0
        self.pn = 0.0
        self.pt = 0.0
        self.key = (a.id, b.id) if b is not None else (a.id, 0)
        # separation along n measured from current positions, so the position
        # pass can track how much overlap remains as bodies get pushed apart:
        # pen_now = pen + sep_base - ((b - a) . n)
        if b is not None:
            self.sep_base = ((b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny)
        else:
            self.sep_base = -(a.pos.x * nx + a.pos.y * ny)

    def _normal_velocity(self) -> float:
        a, b = self.a, self.b
        vax = a.vel.x - a.omega * self.ray
        vay = a.vel.y + a.omega * self.rax
        if b is not None:
            vbx = b.vel.x - b.omega * self.rby
            vby = b.vel.y + b.omega * self.rbx
        else:
            vbx = vby = 0.0
        return (vbx - vax) * self.nx + (vby - vay) * self.ny


def _solve_velocity(manifolds: list[_Manifold], iterations: int) -> None:
    """Iterated sequential impulses with accumulated clamping."""
    for _ in range(iterations):
        worst = 0.0
        for m in manifolds:
            a, b = m.a, m.b
            nx, ny = m.nx, m.ny
            rax, ray, rbx, rby = m.rax, m.ray, m.rbx, m.rby
            inv_ma, inv_mb = m.inv_ma, m.inv_mb
            inv_ia, inv_ib = m.inv_ia, m.inv_ib

            # --- normal impulse -------------------------------------------
            vax = a.vel.x - a.omega * ray
            vay = a.vel.y + a.omega * rax
            if b is not None:
                vbx = b.vel.x - b.omega * rby
                vby = b.vel.y + b.omega * rbx
            else:
                vbx = vby = 0.0
            vn = (vbx - vax) * nx + (vby - vay) * ny
            dpn = -(vn - m.target_vn) / m.k_n
            new_pn = m.pn + dpn
            if new_pn < 0.0:
                new_pn = 0.0
            dpn = new_pn - m.pn
            m.pn = new_pn
            if dpn != 0.0:
                a.vel.x -= dpn * nx * inv_ma
                a.vel.y -= dpn * ny * inv_ma
                a.omega -= m.ra_x_n * dpn * inv_ia
                if b is not None:
                    b.vel.x += dpn * nx * inv_mb
                    b.vel.y += dpn * ny * inv_mb
                    b.omega += m.rb_x_n * dpn * inv_ib
                d = dpn if dpn > 0.0 else -dpn
                if d > worst:
                    worst = d

            # --- friction impulse ------------------------------------------
            if m.mu > 0.0:
                vax = a.vel.x - a.omega * ray
                vay = a.vel.y + a.omega * rax
                if b is not None:
                    vbx = b.vel.x - b.omega * rby
                    vby = b.vel.y + b.omega * rbx
                else:
                    vbx = vby = 0.0
                tx, ty = -ny, nx
                vt = (vbx - vax) * tx + (vby - vay) * ty
                dpt = -vt / m.k_t
                max_f = m.mu * m.pn
                new_pt = m.pt + dpt
                if new_pt > max_f:
                    new_pt = max_f
                elif new_pt < -max_f:
                    new_pt = -max_f
                dpt = new_pt - m.pt
                m.pt = new_pt
                if dpt != 0.0:
                    a.vel.x -= dpt * tx * inv_ma
                    a.vel.y -= dpt * ty * inv_ma
                    a.omega -= m.ra_x_t * dpt * inv_ia
                    if b is not None:
                        b.vel.x += dpt * tx * inv_mb
                        b.vel.y += dpt * ty * inv_mb
                        b.omega += m.rb_x_t * dpt * inv_ib
                    d = dpt if dpt > 0.0 else -dpt
                    if d > worst:
                        worst = d
        if worst < IMPULSE_EPSILON:
            break


def _solve_position(manifolds: list[_Manifold]) -> None:
    """Split-impulse projection: push overlapping bodies apart without
    touching velocities. Iterated so stacks resolve mutual overlap."""
    for _ in range(POSITION_ITERATIONS):
        done = True
        for m in manifolds:
            a, b = m.a, m.b
            nx, ny = m.nx, m.ny
            if b is not None:
                sep = ((b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny)
            else:
                sep = -(a.pos.x * nx + a.pos.y * ny)
            depth = m.pen + m.sep_base - sep - PENETRATION_SLOP
            if depth <= 0.0:
                continue
            done = False
            corr = depth * PROJECTION_PERCENT / m.inv_m_sum
            a.pos.x -= corr * nx * m.inv_ma
            a.pos.y -= corr * ny * m.inv_ma
            if b is not None:
                b.pos.x += corr * nx * m.inv_mb
                b.pos.y += corr * ny * m.inv_mb
        if done:
            break


_NO_EXCLUSIONS: frozenset = frozenset()


def _pair_manifold(a: Body, b: Body, out: list[_Manifold],
                   excl=_NO_EXCLUSIONS) -> None:
    if excl:
        key = (a.id, b.id) if a.id < b.id else (b.id, a.id)
        if key in excl:
            return  # directly linked: the link governs their separation
    dx = b.pos.x - a.pos.x
    dy = b.pos.y - a.pos.y
    r_sum = a.radius + b.radius
    d2 = dx * dx + dy * dy
    if d2 >= r_sum * r_sum:
        return
    if a.inv_mass == 0.0 and b.inv_mass == 0.0:
        return
    d = d2 ** 0.5
    if d < 1e-9:
        nx, ny = 1.0, 0.0
    else:
        nx, ny = dx / d, dy / d
    penetration = r_sum - d
    px = a.pos.x + nx * (a.radius - penetration * 0.5)
    py = a.pos.y + ny * (a.radius - penetration * 0.5)
    e = a.restitution if a.restitution < b.restitution else b.restitution
    mu = (a.friction * b.friction) ** 0.5
    out.append(_Manifold(a, b, nx, ny, penetration, px, py, e, mu))


def _detect_bodies_vec(colliders: list[Body], out: list[_Manifold],
                       static: dict) -> None:
    """All-pairs candidate search as one numpy distance test. O(n^2) memory
    but tiny constants: far faster than Python loops up to many hundreds of
    bodies, and link-excluded pairs are masked out for free.

    Radii, links and mobility cannot change during a step, so their combined
    pair mask is built once per step (`static` cache) and only the positions
    are re-gathered each substep. NaN positions compare False and therefore
    drop out of the candidate set on their own.
    """
    n = len(colliders)
    pair_mask = static.get("pair_mask")
    if pair_mask is None:
        r = np.fromiter((b.radius for b in colliders), np.float64, n)
        movable = np.fromiter((b.inv_mass != 0.0 for b in colliders), bool, n)
        mask = np.triu(np.ones((n, n), bool), 1)
        mask &= movable[None, :] | movable[:, None]
        excl = static.get("no_collide")
        if excl:
            id2i = {b.id: k for k, b in enumerate(colliders)}
            for ida, idb in excl:
                i = id2i.get(ida)
                j = id2i.get(idb)
                if i is not None and j is not None:
                    mask[i, j] = False
                    mask[j, i] = False
        static["pair_mask"] = pair_mask = mask
        static["r_sum2"] = (r[None, :] + r[:, None]) ** 2
    px = np.array([b.pos.x for b in colliders])
    py = np.array([b.pos.y for b in colliders])
    dx = px[None, :] - px[:, None]
    dy = py[None, :] - py[:, None]
    hit = dx * dx + dy * dy < static["r_sum2"]
    hit &= pair_mask
    ii, jj = np.nonzero(hit)
    for i, j in zip(ii.tolist(), jj.tolist()):
        _pair_manifold(colliders[i], colliders[j], out)


def _detect_bodies(bodies: list[Body], out: list[_Manifold],
                   static: dict) -> None:
    colliders = static.get("colliders")
    if colliders is None:
        static["colliders"] = colliders = [b for b in bodies if b.collides]
    n = len(colliders)
    if n < 2:
        return
    excl = static.get("no_collide") or _NO_EXCLUSIONS
    if n >= VEC_MIN_COLLIDERS:
        # all-pairs numpy beats the spatial hash for the dense clusters that
        # spring lattices form (their linked pairs are masked out wholesale);
        # sparse unlinked scenes like gases stay on the O(n) hash
        use_vec = static.get("use_vec")
        if use_vec is None:
            linked_ids = set()
            for ida, idb in excl:
                linked_ids.add(ida)
                linked_ids.add(idb)
            linked = sum(1 for b in colliders if b.id in linked_ids)
            static["use_vec"] = use_vec = linked * 2 >= n
        if use_vec:
            _detect_bodies_vec(colliders, out, static)
            return
    colliders = [b for b in colliders
                 if isfinite(b.pos.x) and isfinite(b.pos.y)]
    n = len(colliders)
    if n < 2:
        return
    if n <= 6:
        for i in range(n):
            a = colliders[i]
            for j in range(i + 1, n):
                _pair_manifold(a, colliders[j], out, excl)
        return

    # split off outsize bodies so they don't inflate the hash cells
    radii = sorted(b.radius for b in colliders)
    r_med = radii[n // 2]
    big_cut = 3.0 * r_med
    small: list[Body] = []
    large: list[Body] = []
    for b in colliders:
        (large if b.radius > big_cut else small).append(b)

    for i, a in enumerate(large):
        for b in large[i + 1:]:
            _pair_manifold(a, b, out, excl)
        for b in small:
            _pair_manifold(a, b, out, excl)

    if len(small) < 2:
        return
    cell = 2.0 * max(b.radius for b in small)
    if cell <= 1e-9:
        return
    inv_cell = 1.0 / cell
    grid: dict[tuple[int, int], list[Body]] = {}
    for b in small:
        key = (int(b.pos.x * inv_cell) if b.pos.x >= 0 else int(b.pos.x * inv_cell) - 1,
               int(b.pos.y * inv_cell) if b.pos.y >= 0 else int(b.pos.y * inv_cell) - 1)
        bucket = grid.get(key)
        if bucket is None:
            grid[key] = [b]
        else:
            bucket.append(b)
    grid_get = grid.get
    # forward half-neighbourhood: every unordered cell pair visited once
    for (gx, gy), bucket in grid.items():
        ln = len(bucket)
        for i in range(ln):
            a = bucket[i]
            for j in range(i + 1, ln):
                _pair_manifold(a, bucket[j], out, excl)
        for ox, oy in ((1, 0), (1, 1), (0, 1), (-1, 1)):
            other = grid_get((gx + ox, gy + oy))
            if other:
                for a in bucket:
                    for b in other:
                        _pair_manifold(a, b, out, excl)


def _wall_manifold(body: Body, w: Wall, ax: float, ay: float, sx: float,
                   sy: float, seg_len2: float, half_t: float,
                   out: list[_Manifold]) -> None:
    """Narrowphase circle-vs-capsule test; appends a manifold on overlap."""
    px, py = body.pos.x, body.pos.y
    # closest point on the segment to the body centre
    if seg_len2 > 0.0:
        t = ((px - ax) * sx + (py - ay) * sy) / seg_len2
        if t < 0.0:
            t = 0.0
        elif t > 1.0:
            t = 1.0
    else:
        t = 0.0
    cx, cy = ax + sx * t, ay + sy * t
    dx, dy = px - cx, py - cy
    reach = body.radius + half_t
    d2 = dx * dx + dy * dy
    if d2 >= reach * reach:
        return
    d = d2 ** 0.5
    if d < 1e-9:
        # centre exactly on the segment: push out along the normal
        inv = 1.0 / (seg_len2 ** 0.5) if seg_len2 > 0 else 1.0
        nx, ny = -sy * inv, sx * inv
    else:
        nx, ny = dx / d, dy / d
    penetration = reach - d
    cpx = px - nx * (body.radius - penetration * 0.5)
    cpy = py - ny * (body.radius - penetration * 0.5)
    e = body.restitution if body.restitution < w.restitution else w.restitution
    mu = (body.friction * w.friction) ** 0.5
    # manifold normal points from the body (a) into the wall
    m = _Manifold(body, None, -nx, -ny, penetration, cpx, cpy, e, mu)
    m.key = (body.id, -w.id)
    out.append(m)


def _detect_walls(bodies: list[Body], walls: list[Wall],
                  out: list[_Manifold], static: dict) -> None:
    if not walls:
        return
    movers = static.get("movers")
    if movers is None:
        # NaN positions drop out of both paths' comparisons on their own
        static["movers"] = movers = [b for b in bodies
                                     if b.collides and b.inv_mass != 0.0]
    if not movers:
        return

    if len(movers) >= VEC_MIN_COLLIDERS:
        # vectorized candidate pass: one closest-point test per wall over
        # all bodies at once, then exact narrowphase on the few hits
        n = len(movers)
        r = static.get("mover_r")
        if r is None:
            static["mover_r"] = r = np.fromiter(
                (b.radius for b in movers), np.float64, n)
        px = np.array([b.pos.x for b in movers])
        py = np.array([b.pos.y for b in movers])
        for w in walls:
            ax, ay = w.a.x, w.a.y
            sx, sy = w.b.x - ax, w.b.y - ay
            seg_len2 = sx * sx + sy * sy
            half_t = w.thickness * 0.5
            if seg_len2 > 0.0:
                t = ((px - ax) * sx + (py - ay) * sy) / seg_len2
                np.clip(t, 0.0, 1.0, out=t)
            else:
                t = 0.0
            dx = px - (ax + sx * t)
            dy = py - (ay + sy * t)
            reach = r + half_t
            hits = np.nonzero(dx * dx + dy * dy < reach * reach)[0]
            for i in hits.tolist():
                _wall_manifold(movers[i], w, ax, ay, sx, sy, seg_len2,
                               half_t, out)
        return

    max_r = max(b.radius for b in movers)
    for w in walls:
        ax, ay = w.a.x, w.a.y
        bx, by = w.b.x, w.b.y
        sx, sy = bx - ax, by - ay
        seg_len2 = sx * sx + sy * sy
        half_t = w.thickness * 0.5
        reach_max = max_r + half_t
        lo_x = (ax if ax < bx else bx) - reach_max
        hi_x = (ax if ax > bx else bx) + reach_max
        lo_y = (ay if ay < by else by) - reach_max
        hi_y = (ay if ay > by else by) + reach_max
        for body in movers:
            px, py = body.pos.x, body.pos.y
            if lo_x <= px <= hi_x and lo_y <= py <= hi_y:
                _wall_manifold(body, w, ax, ay, sx, sy, seg_len2, half_t, out)


def _warm_start(manifolds: list[_Manifold], cache: dict) -> None:
    """Re-apply the impulses each persistent contact carried last substep.

    Resting stacks then start each substep already near equilibrium, so a
    couple of polish iterations converge instead of rebuilding the whole
    load-bearing impulse chain from zero every substep (Box2D's scheme)."""
    for m in manifolds:
        cached = cache.get(m.key)
        if cached is None:
            continue
        pn, pt = cached
        m.pn = pn
        m.pt = pt
        nx, ny = m.nx, m.ny
        ix = pn * nx - pt * ny
        iy = pn * ny + pt * nx
        a, b = m.a, m.b
        a.vel.x -= ix * m.inv_ma
        a.vel.y -= iy * m.inv_ma
        a.omega -= (m.ra_x_n * pn + m.ra_x_t * pt) * m.inv_ia
        if b is not None:
            b.vel.x += ix * m.inv_mb
            b.vel.y += iy * m.inv_mb
            b.omega += (m.rb_x_n * pn + m.rb_x_t * pt) * m.inv_ib


def solve_contacts(bodies: list[Body], walls: list[Wall],
                   contacts: list[Contact], iterations: int,
                   cache: dict | None = None,
                   static: dict | None = None) -> None:
    """Detect all contacts this substep and resolve them together.

    `cache` is an optional persistent dict carrying accumulated impulses
    between substeps (warm starting); pass the same dict every substep.
    `static` is an optional per-step dict for detection state that cannot
    change within a step (collider lists, radii, link exclusions); pass a fresh
    dict at the start of every step.
    """
    manifolds: list[_Manifold] = []
    if static is None:
        static = {}
    _detect_bodies(bodies, manifolds, static)
    _detect_walls(bodies, walls, manifolds, static)
    if cache is not None:
        if manifolds:
            _warm_start(manifolds, cache)
        cache.clear()
    if not manifolds:
        return
    _solve_velocity(manifolds, iterations)
    _solve_position(manifolds)
    for m in manifolds:
        contacts.append(Contact(m.px, m.py, m.nx, m.ny, m.pn))
        if cache is not None:
            cache[m.key] = (m.pn, m.pt)
