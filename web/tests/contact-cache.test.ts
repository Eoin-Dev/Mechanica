/** The warm-start cache identifies a contact by its PAIR, not by the order
 * the broadphase happened to visit it in.
 *
 * Which of two bodies the narrowphase calls `a` falls out of the spatial
 * hash: it depends on which cell was seen first and which cell is the
 * forward neighbour of which, and both change as bodies move between
 * cells. A detection-ordered key therefore looked like a brand-new contact
 * every time a resting pair flipped, discarding the accumulated impulse
 * that warm starting exists to carry between substeps.
 *
 * Re-keying is only safe if the cached scalars mean the same thing either
 * way round, so that is checked here directly rather than argued: the
 * normal reverses with the pair, and so does the tangent, which leaves
 * both `pn` and `pt` invariant.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { Contact, ContactCache, solveContacts } from "../src/engine/contacts";

/** Two overlapping discs with asymmetric motion, so any sign error shows. */
function pair(): [Body, Body] {
  const a = new Body(new Vec2(0, 0), 0.2, 1.0);
  const b = new Body(new Vec2(0.3, 0.05), 0.2, 1.5);
  a.vel.set(1.0, 0.3);
  b.vel.set(-0.5, 0.2);
  a.omega = 0.7;
  b.omega = -0.4;
  return [a, b];
}

function stateOf(b: Body): number[] {
  return [b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.omega];
}

/** Run `substeps` substeps over one persistent cache, with the body list in
 * the given order, and return the two bodies' final states keyed by name. */
function run(swap: boolean, substeps: number): { a: number[]; b: number[]; keys: string[] } {
  const [a, b] = pair();
  const bodies = swap ? [b, a] : [a, b];
  const cache: ContactCache = new Map();
  for (let i = 0; i < substeps; i++) {
    const contacts: Contact[] = [];
    solveContacts(bodies, [], contacts, 8, cache, {});
  }
  return { a: stateOf(a), b: stateOf(b), keys: [...cache.keys()].sort() };
}

describe("contact warm-start cache", () => {
  it("gives a pair the same key whichever way round it is detected", () => {
    // one pair, two orderings, a fresh cache each: same ids, so the keys
    // are directly comparable (ids are global and never reused, so two
    // separately built pairs would differ for uninteresting reasons)
    const [a, b] = pair();
    const keysFor = (bodies: Body[]): string[] => {
      const cache: ContactCache = new Map();
      solveContacts(bodies, [], [], 8, cache, {});
      return [...cache.keys()];
    };
    const straight = keysFor([a, b]);
    const swapped = keysFor([b, a]);
    expect(straight).toHaveLength(1);
    expect(swapped).toEqual(straight);
    expect(straight[0]).toBe(`${Math.min(a.id, b.id)},${Math.max(a.id, b.id)}`);
  });

  it("resolves a contact identically whichever way round it is detected", () => {
    // if pn or pt were order-dependent, the warm start would apply the
    // previous substep's impulse backwards and the two would diverge
    const straight = run(false, 8);
    const swapped = run(true, 8);
    for (let i = 0; i < straight.a.length; i++) {
      expect(straight.a[i]).toBeCloseTo(swapped.a[i], 12);
      expect(straight.b[i]).toBeCloseTo(swapped.b[i], 12);
    }
  });

  it("keeps the impulse when the pair's detection order flips mid-run", () => {
    // Drive the flip explicitly: same cache, alternating body order. A
    // detection-ordered key made every substep a cache miss here, so the
    // load-bearing impulse was rebuilt from zero each time.
    const [a, b] = pair();
    const cache: ContactCache = new Map();
    for (let i = 0; i < 8; i++) {
      const contacts: Contact[] = [];
      solveContacts(i % 2 === 0 ? [a, b] : [b, a], [], contacts, 8, cache, {});
      // exactly one entry however the order alternates: one pair, one key
      expect(cache.size).toBe(1);
    }
    const flipped = [stateOf(a), stateOf(b)];
    const steady = run(false, 8);
    for (let i = 0; i < flipped[0].length; i++) {
      expect(flipped[0][i]).toBeCloseTo(steady.a[i], 12);
      expect(flipped[1][i]).toBeCloseTo(steady.b[i], 12);
    }
  });

  it("never collides a wall contact with a body-body contact", () => {
    // walls key on their own negative id; bodies on a sorted pair of
    // positive ones, so the two families cannot overlap
    const a = new Body(new Vec2(0, 0.15), 0.2, 1.0);
    const b = new Body(new Vec2(0.3, 0.15), 0.2, 1.0);
    const wall = new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0.1);
    const cache: ContactCache = new Map();
    const contacts: Contact[] = [];
    solveContacts([a, b], [wall], contacts, 8, cache, {});
    // one body-body contact plus one wall contact per body
    expect(cache.size).toBe(3);
    expect(new Set(cache.keys()).size).toBe(3);
  });
});
