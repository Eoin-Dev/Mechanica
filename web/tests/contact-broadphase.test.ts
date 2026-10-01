/** Contact detection must agree with exhaustive circle overlap tests across
 * compact, sparse, translated and changing scenes. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { Contact, solveContacts } from "../src/engine/contacts";

function pairKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

/** Independent all-pairs oracle: no spatial bins or size split. */
function overlaps(bodies: Body[], excluded = new Set<string>()): string[] {
  const expected: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (!a.collides || !Number.isFinite(a.pos.x) || !Number.isFinite(a.pos.y)) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b.collides || !Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y)) continue;
      if (a.invMass === 0 && b.invMass === 0) continue;
      const key = pairKey(a.id, b.id);
      if (!excluded.has(key) && Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) < a.radius + b.radius) {
        expected.push(key);
      }
    }
  }
  return expected.sort();
}

function detect(bodies: Body[], excluded = new Set<string>()): Contact[] {
  const contacts: Contact[] = [];
  solveContacts(bodies, [], contacts, 0, null, {
    noCollide: excluded, positionIterations: 0, impactIterations: 0, simplified: true,
  });
  return contacts;
}

function check(bodies: Body[], excluded = new Set<string>()): void {
  const expected = overlaps(bodies, excluded);
  const contacts = detect(bodies, excluded);
  const actual = contacts.map(contact => pairKey(contact.bodyAId, contact.bodyBId!));
  expect(new Set(actual).size).toBe(actual.length);
  expect(actual.sort()).toEqual(expected);
  for (const contact of contacts) {
    expect([contact.px, contact.py, contact.nx, contact.ny].every(Number.isFinite)).toBe(true);
  }
}

function cluster(count: number, spacing = 0.35, radius = 0.25): Body[] {
  return Array.from({ length: count }, (_, index) =>
    new Body(new Vec2(index % 12 * spacing - 2, Math.floor(index / 12) * spacing - 2), radius));
}

describe("size-aware contact broadphase", () => {
  it.each([7, 50, 200, 500])("finds every compact overlap among %i bodies", count => {
    check(cluster(count));
  });

  it("handles negative cell boundaries, tangency and coincident centres", () => {
    const bodies = cluster(30, 0.5);
    bodies[0].pos.set(-1.0000001, -0.5);
    bodies[1].pos.set(-0.5000002, -0.5);
    bodies[2].pos.set(-0.5, -1);
    bodies[3].pos.setVec(bodies[2].pos);
    bodies[4].pos.set(0, -1);
    check(bodies);
  });

  it("retains exact cell identities beyond signed 32-bit coordinates", () => {
    const bodies = cluster(30, 0.00015, 0.0001);
    for (const body of bodies) {
      body.pos.x += 1000000;
      body.pos.y -= 1000000;
    }
    check(bodies);
    // Separating these otherwise identical clusters exercises the sparse
    // lookup with wrapped integer hashes and distinct float64 identities.
    bodies.push(...bodies.map(body => new Body(new Vec2(body.pos.x - 859000, body.pos.y), body.radius)));
    check(bodies);
  });

  it("rebuilds correctly as the same bodies spread, regroup and change size", () => {
    const bodies = cluster(200);
    check(bodies);
    for (let index = 0; index < bodies.length; index++) {
      bodies[index].pos.set(index * 50, index % 3 * 50);
    }
    check(bodies);
    for (let index = 0; index < bodies.length; index++) {
      bodies[index].pos.set(index % 12 * 0.35, Math.floor(index / 12) * 0.35);
    }
    bodies[0].radius = 4;
    bodies.splice(20, 100);
    bodies.push(...cluster(500, 0.8, 0.5));
    check(bodies);
    check(cluster(7));
    check(cluster(500));
  });

  it("finds outsize contacts and respects locked, disabled and excluded pairs", () => {
    const bodies = cluster(100);
    bodies[0].radius = 4;
    bodies[1].radius = 3;
    bodies[2].collides = false;
    bodies[3].locked = true;
    bodies[4].locked = true;
    const excluded = new Set([pairKey(bodies[0].id, bodies[1].id), pairKey(bodies[0].id, bodies[5].id)]);
    check(bodies, excluded);
    bodies[2].collides = true;
    bodies[3].locked = false;
    check(bodies);
  });

  it("ignores non-finite positions while detecting the remaining bodies", () => {
    const bodies = cluster(50);
    bodies[0].pos.x = NaN;
    bodies[1].pos.y = Infinity;
    bodies[2].pos.x = -Infinity;
    check(bodies);
    for (const body of bodies) body.pos.set(NaN, Infinity);
    expect(detect(bodies)).toEqual([]);
    check(cluster(50));
  });

  it("agrees with exhaustive detection in seeded mixed-size scenes", () => {
    let seed = 0x4d454348;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let trial = 0; trial < 20; trial++) {
      const bodies = Array.from({ length: 80 }, () => {
        const body = new Body(new Vec2(random() * 8 - 4, random() * 8 - 4), 0.05 + random() ** 3 * 2);
        body.collides = random() > 0.1;
        body.locked = random() < 0.2;
        return body;
      });
      check(bodies);
      for (const body of bodies) body.pos.x += trial % 2 ? 999000 : -999000;
      check(bodies);
    }
  });

  it("wakes sleeping bodies reached by live bodies in compact and sparse layouts", () => {
    for (const sparse of [false, true]) {
      const bodies = cluster(7);
      bodies[0].pos.set(0, 0);
      bodies[1].pos.set(0.4, 0);
      for (let index = 2; index < bodies.length; index++) {
        bodies[index].pos.set(index * (sparse ? 100 : 1), 0);
      }
      bodies[0].perfSleeping = true;
      bodies[0].perfSleepFrames = 100;
      const contacts = detect(bodies);
      expect(contacts.map(contact => pairKey(contact.bodyAId, contact.bodyBId!)))
        .toContain(pairKey(bodies[0].id, bodies[1].id));
      expect(bodies[0].perfSleeping).toBe(false);
      expect(bodies[0].perfSleepFrames).toBe(0);
    }
  });
});
