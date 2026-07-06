"""Collision detection and response.

Broadphase: uniform spatial hash rebuilt per step (O(n) build, O(1) queries;
simpler and faster in pure Python than the quadtree it replaces).
Narrowphase: circle-circle and circle-capsule (wall) tests.
Response: sequential impulses with restitution and Coulomb friction. Friction
impulses are applied at the contact point and produce torque, so rolling
emerges naturally. Penetration is removed with split-impulse positional
projection, which does not inject kinetic energy.
"""
from __future__ import annotations

from mechanica.engine.body import Body, Wall

# Below this approach speed the bounce is treated as inelastic to stop
# resting objects from jittering (matches the original simulator's intent).
RESTING_SPEED = 0.10
PENETRATION_SLOP = 0.0005   # m of overlap tolerated before projection
PROJECTION_PERCENT = 0.8


class Contact:
    """A resolved contact, kept for visualization/diagnostics."""

    __slots__ = ("px", "py", "nx", "ny", "impulse")

    def __init__(self, px: float, py: float, nx: float, ny: float, impulse: float) -> None:
        self.px, self.py, self.nx, self.ny, self.impulse = px, py, nx, ny, impulse


class SpatialHash:
    __slots__ = ("cell", "grid")

    def __init__(self, cell: float) -> None:
        self.cell = cell
        self.grid: dict[tuple[int, int], list[Body]] = {}

    def insert(self, body: Body) -> None:
        c = self.cell
        r = body.radius
        x0 = int((body.pos.x - r) // c)
        x1 = int((body.pos.x + r) // c)
        y0 = int((body.pos.y - r) // c)
        y1 = int((body.pos.y + r) // c)
        grid = self.grid
        for gx in range(x0, x1 + 1):
            for gy in range(y0, y1 + 1):
                key = (gx, gy)
                bucket = grid.get(key)
                if bucket is None:
                    grid[key] = [body]
                else:
                    bucket.append(body)

    def query_rect(self, min_x: float, min_y: float, max_x: float, max_y: float) -> set[Body]:
        c = self.cell
        found: set[Body] = set()
        for gx in range(int(min_x // c), int(max_x // c) + 1):
            for gy in range(int(min_y // c), int(max_y // c) + 1):
                bucket = self.grid.get((gx, gy))
                if bucket:
                    found.update(bucket)
        return found


def _resolve(a: Body, b: Body | None, nx: float, ny: float, penetration: float,
             px: float, py: float, e: float, mu: float,
             contacts: list[Contact]) -> None:
    """Resolve a contact with normal n pointing from a toward b (or into the
    wall when b is None, in which case the wall is treated as infinite mass)."""
    inv_ma = a.inv_mass
    inv_ia = a.inv_inertia
    if b is not None:
        inv_mb = b.inv_mass
        inv_ib = b.inv_inertia
    else:
        inv_mb = 0.0
        inv_ib = 0.0
    inv_m_sum = inv_ma + inv_mb
    if inv_m_sum == 0.0:
        return

    # contact-point offsets from each centre
    rax, ray = px - a.pos.x, py - a.pos.y
    if b is not None:
        rbx, rby = px - b.pos.x, py - b.pos.y
    else:
        rbx = rby = 0.0

    # relative velocity of b w.r.t. a at the contact point (omega x r in 2D)
    vax = a.vel.x - a.omega * ray
    vay = a.vel.y + a.omega * rax
    if b is not None:
        vbx = b.vel.x - b.omega * rby
        vby = b.vel.y + b.omega * rbx
    else:
        vbx = vby = 0.0
    rvx, rvy = vbx - vax, vby - vay
    vn = rvx * nx + rvy * ny

    jn = 0.0
    if vn < 0.0:
        if -vn < RESTING_SPEED:
            e = 0.0
        ra_x_n = rax * ny - ray * nx
        rb_x_n = rbx * ny - rby * nx
        k_normal = inv_m_sum + ra_x_n * ra_x_n * inv_ia + rb_x_n * rb_x_n * inv_ib
        jn = -(1.0 + e) * vn / k_normal
        a.vel.x -= jn * nx * inv_ma
        a.vel.y -= jn * ny * inv_ma
        a.omega -= ra_x_n * jn * inv_ia
        if b is not None:
            b.vel.x += jn * nx * inv_mb
            b.vel.y += jn * ny * inv_mb
            b.omega += rb_x_n * jn * inv_ib

        # Coulomb friction along the tangent, applied at the contact point
        if mu > 0.0:
            # recompute contact velocities after the normal impulse
            vax = a.vel.x - a.omega * ray
            vay = a.vel.y + a.omega * rax
            if b is not None:
                vbx = b.vel.x - b.omega * rby
                vby = b.vel.y + b.omega * rbx
            else:
                vbx = vby = 0.0
            rvx, rvy = vbx - vax, vby - vay
            tx, ty = -ny, nx
            vt = rvx * tx + rvy * ty
            if vt != 0.0:
                ra_x_t = rax * ty - ray * tx
                rb_x_t = rbx * ty - rby * tx
                k_tangent = inv_m_sum + ra_x_t * ra_x_t * inv_ia + rb_x_t * rb_x_t * inv_ib
                jt = -vt / k_tangent
                max_jt = mu * jn
                if jt > max_jt:
                    jt = max_jt
                elif jt < -max_jt:
                    jt = -max_jt
                a.vel.x -= jt * tx * inv_ma
                a.vel.y -= jt * ty * inv_ma
                a.omega -= ra_x_t * jt * inv_ia
                if b is not None:
                    b.vel.x += jt * tx * inv_mb
                    b.vel.y += jt * ty * inv_mb
                    b.omega += rb_x_t * jt * inv_ib

    # positional projection (split impulse: no velocity change)
    depth = penetration - PENETRATION_SLOP
    if depth > 0.0:
        corr = depth * PROJECTION_PERCENT / inv_m_sum
        a.pos.x -= corr * nx * inv_ma
        a.pos.y -= corr * ny * inv_ma
        if b is not None:
            b.pos.x += corr * nx * inv_mb
            b.pos.y += corr * ny * inv_mb

    contacts.append(Contact(px, py, nx, ny, jn))


def collide_bodies(bodies: list[Body], contacts: list[Contact]) -> None:
    """Detect and resolve all body-body collisions via the spatial hash."""
    colliders = [b for b in bodies if b.collides]
    n = len(colliders)
    if n < 2:
        return
    max_r = max(b.radius for b in colliders)
    hash_ = SpatialHash(max(4.0 * max_r, 0.05))
    for b in colliders:
        hash_.insert(b)

    seen: set[tuple[int, int]] = set()
    for a in colliders:
        r = a.radius + max_r
        near = hash_.query_rect(a.pos.x - r, a.pos.y - r, a.pos.x + r, a.pos.y + r)
        for b in near:
            if b is a or b.id <= a.id:
                continue
            key = (a.id, b.id)
            if key in seen:
                continue
            seen.add(key)
            dx = b.pos.x - a.pos.x
            dy = b.pos.y - a.pos.y
            r_sum = a.radius + b.radius
            d2 = dx * dx + dy * dy
            if d2 >= r_sum * r_sum:
                continue
            d = d2 ** 0.5
            if d < 1e-9:
                nx, ny, d = 1.0, 0.0, 1e-9
            else:
                nx, ny = dx / d, dy / d
            penetration = r_sum - d
            px = a.pos.x + nx * (a.radius - penetration * 0.5)
            py = a.pos.y + ny * (a.radius - penetration * 0.5)
            e = min(a.restitution, b.restitution)
            mu = (a.friction * b.friction) ** 0.5
            _resolve(a, b, nx, ny, penetration, px, py, e, mu, contacts)


def collide_walls(bodies: list[Body], walls: list[Wall], contacts: list[Contact]) -> None:
    """Detect and resolve collisions between bodies and static wall capsules."""
    for w in walls:
        ax, ay = w.a.x, w.a.y
        sx, sy = w.b.x - ax, w.b.y - ay
        seg_len2 = sx * sx + sy * sy
        half_t = w.thickness * 0.5
        for body in bodies:
            if not body.collides or body.inv_mass == 0.0:
                continue
            # closest point on the segment to the body centre
            if seg_len2 > 0.0:
                t = ((body.pos.x - ax) * sx + (body.pos.y - ay) * sy) / seg_len2
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
            else:
                t = 0.0
            cx, cy = ax + sx * t, ay + sy * t
            dx, dy = body.pos.x - cx, body.pos.y - cy
            reach = body.radius + half_t
            d2 = dx * dx + dy * dy
            if d2 >= reach * reach:
                continue
            d = d2 ** 0.5
            if d < 1e-9:
                # centre exactly on the segment: push out along the segment normal
                inv = 1.0 / (seg_len2 ** 0.5) if seg_len2 > 0 else 1.0
                nx, ny = -sy * inv, sx * inv
                d = 1e-9
            else:
                nx, ny = dx / d, dy / d
            penetration = reach - d
            # normal from wall toward the body; _resolve expects a->b, so flip
            px, py = body.pos.x - nx * (body.radius - penetration * 0.5), \
                     body.pos.y - ny * (body.radius - penetration * 0.5)
            e = min(body.restitution, w.restitution)
            mu = (body.friction * w.friction) ** 0.5
            _resolve(body, None, -nx, -ny, penetration, px, py, e, mu, contacts)
