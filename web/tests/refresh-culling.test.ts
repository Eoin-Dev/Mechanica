/** RefreshGroup's culling must not swallow a control that hides itself.
 *
 * The Inspector skips refreshing controls scrolled out of view, which is what
 * keeps a panel of hundreds of rows off the frame budget. It decides that from
 * an IntersectionObserver, and "not intersecting" turned out to mean two
 * unrelated things: scrolled away (a box, outside the root) and hidden (no box
 * at all).
 *
 * Treating the second as culled is self-locking. A control that owns its own
 * visibility hides itself inside its own refresh, which is precisely the
 * moment it loses its box - so it was culled there and its refresh never ran
 * again, leaving it hidden for good. Three controls in the Inspector were
 * stuck that way, and the visible symptom was that they appeared only after a
 * tab switch: turning on performance mode while already looking at the World
 * tab left the banner that explains the greyed-out solver settings invisible.
 *
 * These tests drive the observer by hand, because a real one needs frames.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefreshGroup } from "../src/ui/dom";

interface FakeEntry {
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: { width: number; height: number };
}

/** Just enough IntersectionObserver for RefreshGroup, with delivery under the
 * test's control. RefreshGroup only ever uses a control's root as a map key
 * and an observe() argument, so plain objects stand in for elements. */
class FakeObserver {
  static live: FakeObserver[] = [];
  private readonly cb: (entries: FakeEntry[]) => void;
  observed: Element[] = [];

  constructor(cb: (entries: FakeEntry[]) => void) {
    this.cb = cb;
    FakeObserver.live.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.observed = [];
  }

  /** What the browser would report on the frame after a layout change. */
  deliver(entries: FakeEntry[]): void {
    this.cb(entries);
  }
}

const scrolledAway = (target: Element): FakeEntry =>
  ({ target, isIntersecting: false, boundingClientRect: { width: 180, height: 24 } });
const inView = (target: Element): FakeEntry =>
  ({ target, isIntersecting: true, boundingClientRect: { width: 180, height: 24 } });
/** A hidden control: the observer reports no box at all. */
const boxless = (target: Element): FakeEntry =>
  ({ target, isIntersecting: false, boundingClientRect: { width: 0, height: 0 } });

const fakeEl = (): HTMLElement => ({}) as HTMLElement;

describe("refresh culling", () => {
  let saved: unknown;

  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver;
    FakeObserver.live = [];
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = saved;
  });

  /** A group with culling active, plus a control counting its refreshes. */
  function harness(): { group: RefreshGroup; root: HTMLElement;
                        io: FakeObserver; count: () => number } {
    const group = new RefreshGroup();
    group.cullWithin(fakeEl());
    const root = fakeEl();
    let n = 0;
    group.add({ root, refresh: () => { n++; } });
    return { group, root, io: FakeObserver.live[0], count: () => n };
  }

  it("skips a control scrolled out of the panel", () => {
    const { group, root, io, count } = harness();
    group.refreshAll();
    expect(count()).toBe(1);
    io.deliver([scrolledAway(root)]);
    group.refreshAll();
    group.refreshAll();
    expect(count()).toBe(1); // culled: that is the whole point of the culling
  });

  it("keeps refreshing a control that has no box", () => {
    const { group, root, io, count } = harness();
    io.deliver([boxless(root)]);
    group.refreshAll();
    group.refreshAll();
    expect(count()).toBe(2);
  });

  it("lets a control that hid itself come back", () => {
    // The regression this file exists for, in the shape the Inspector's
    // performance-mode banner has: visibility decided inside its own refresh.
    const group = new RefreshGroup();
    group.cullWithin(fakeEl());
    const root = fakeEl();
    let modeOn = false;
    let hidden = false;
    group.add({ root, refresh: () => { hidden = !modeOn; } });

    group.refreshAll();
    expect(hidden).toBe(true); // nothing to say yet, so it hid itself
    // which is exactly when the browser reports it as having no box
    FakeObserver.live[0].deliver([boxless(root)]);

    modeOn = true; // the user ticks Performance mode in Settings
    group.refreshAll();
    expect(hidden).toBe(false);
  });

  it("resumes culling once a control has a box again", () => {
    // The exemption is for boxless controls only - it must not leak into a
    // permanent opt-out, or scrolling a long panel would refresh everything.
    const { group, root, io, count } = harness();
    io.deliver([boxless(root)]);
    group.refreshAll();
    expect(count()).toBe(1);
    io.deliver([inView(root)]);      // shown again
    group.refreshAll();
    expect(count()).toBe(2);
    io.deliver([scrolledAway(root)]); // and now scrolled past
    group.refreshAll();
    expect(count()).toBe(2);
  });

  it("ignores entries for controls it does not own", () => {
    const { group, io, count } = harness();
    io.deliver([scrolledAway(fakeEl())]); // a stale target from a cleared group
    group.refreshAll();
    expect(count()).toBe(1);
  });

  it("refreshes everything when there is no IntersectionObserver", () => {
    // node, and older browsers: culling is an optimisation, never a
    // requirement, so its absence must not stop anything refreshing
    (globalThis as Record<string, unknown>).IntersectionObserver = undefined;
    const group = new RefreshGroup();
    group.cullWithin(fakeEl());
    let n = 0;
    group.add({ root: fakeEl(), refresh: () => { n++; } });
    group.refreshAll();
    group.refreshAll();
    expect(n).toBe(2);
  });
});
