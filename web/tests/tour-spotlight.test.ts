/** The tour's spotlight survives being replayed.
 *
 * Tour pools its dark tiles and highlight rings so a reflow reuses divs
 * instead of rebuilding them. finish() removed the root that owned those
 * divs but kept the pool, so the SECOND run - Settings' "Replay the tour"
 * and Help's "Take the tour", the only two ways anyone sees it twice -
 * reused elements that were no longer in the document. Nothing was
 * appended to the new scrim, so the replay showed a card floating over a
 * completely undimmed page with no ring on anything.
 *
 * The existing tour test checks the step DATA against the page shell,
 * which is why this went unnoticed: nothing exercised the tour's DOM. It
 * needs a document, and the suite runs under plain Node, so this file
 * stands up the smallest stub the tour actually touches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { STEPS, Tour } from "../src/ui/tour";

// --------------------------------------------------------------- DOM stub
interface StubEl {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  tabIndex: number;
  style: Record<string, unknown> & { cssText: string };
  dataset: Record<string, string>;
  children: StubEl[];
  parent: StubEl | null;
  offsetWidth: number;
  offsetHeight: number;
  append(...kids: Array<StubEl | string>): void;
  replaceChildren(...kids: Array<StubEl | string>): void;
  insertBefore(node: StubEl, before: StubEl | null): void;
  remove(): void;
  focus(): void;
  addEventListener(): void;
  setAttribute(k: string, v: string): void;
  getBoundingClientRect(): { left: number; top: number; right: number;
                             bottom: number; width: number; height: number };
  getClientRects(): unknown[];
}

function makeEl(tag: string): StubEl {
  const node: StubEl = {
    tagName: tag.toUpperCase(),
    className: "", textContent: "", hidden: false, tabIndex: 0,
    style: { cssText: "" } as StubEl["style"],
    dataset: {}, children: [], parent: null,
    offsetWidth: 320, offsetHeight: 180,
    append(...kids) {
      for (const k of kids) {
        if (typeof k === "string") continue;
        k.parent = node;
        node.children.push(k);
      }
    },
    replaceChildren(...kids) {
      for (const c of node.children) c.parent = null;
      node.children = [];
      node.append(...kids);
    },
    insertBefore(child, before) {
      child.parent = node;
      const i = before === null ? -1 : node.children.indexOf(before);
      if (i < 0) node.children.push(child);
      else node.children.splice(i, 0, child);
    },
    remove() {
      const p = node.parent;
      if (p === null) return;
      const i = p.children.indexOf(node);
      if (i >= 0) p.children.splice(i, 1);
      node.parent = null;
    },
    focus() {},
    addEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 40, top: 40, right: 240, bottom: 140,
                                    width: 200, height: 100 }),
    getClientRects: () => [{}],
  };
  return node;
}

/** Every element currently reachable from document.body, by class. */
function inDocument(body: StubEl, cls: string): StubEl[] {
  const out: StubEl[] = [];
  const walk = (n: StubEl): void => {
    if (n.className === cls) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(body);
  return out;
}

let body: StubEl;

beforeEach(() => {
  body = makeEl("body");
  const doc = {
    body,
    createElement: (tag: string) => makeEl(tag),
    addEventListener() {},
    removeEventListener() {},
    // every step target resolves to one visible element
    querySelectorAll: () => [makeEl("div")],
  };
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.window = {
    innerWidth: 1280, innerHeight: 800,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.window;
});

function stubApp(): App {
  return { playing: false, settings: {}, saveSettings() {} } as unknown as App;
}

describe("tour spotlight", () => {
  it("paints tiles and rings that are actually in the document", () => {
    const tour = new Tour(stubApp());
    tour.start();
    expect(inDocument(body, "tour-tile").length).toBeGreaterThan(0);
    tour.finish();
  });

  it("paints them again on every replay, not just the first run", () => {
    const tour = new Tour(stubApp());
    const counts: Array<{ tiles: number; rings: number }> = [];
    for (let run = 0; run < 3; run++) {
      tour.start();
      // step onto an anchored step so there are holes to ring
      (tour as unknown as { go(n: number): void }).go(1);
      counts.push({ tiles: inDocument(body, "tour-tile").length,
                    rings: inDocument(body, "tour-ring").length });
      tour.finish();
    }
    // the first run was always fine; runs 2 and 3 used to report 0 and 0
    for (const [i, c] of counts.entries()) {
      expect(c.tiles, `run ${i + 1} tiles`).toBeGreaterThan(0);
      expect(c.rings, `run ${i + 1} rings`).toBeGreaterThan(0);
    }
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[2]).toEqual(counts[0]);
  });

  it("leaves nothing behind in the document once it finishes", () => {
    const tour = new Tour(stubApp());
    tour.start();
    (tour as unknown as { go(n: number): void }).go(1);
    tour.finish();
    expect(inDocument(body, "tour-root")).toHaveLength(0);
    expect(inDocument(body, "tour-tile")).toHaveLength(0);
    expect(inDocument(body, "tour-ring")).toHaveLength(0);
    expect(body.children).toHaveLength(0);
  });

  it("restores the playback state it found, on every run", () => {
    for (const wasPlaying of [false, true]) {
      const app = stubApp();
      app.playing = wasPlaying;
      const tour = new Tour(app);
      tour.start();
      for (let i = 0; i < STEPS.length; i++) {
        (tour as unknown as { go(n: number): void }).go(1);
      }
      expect(tour.visible).toBe(false); // ran off the end and closed itself
      expect(app.playing).toBe(wasPlaying);
    }
  });
});
