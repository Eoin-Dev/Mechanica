/** The first-run tour points at real elements.
 *
 * A step whose target no longer exists is dropped silently at runtime -
 * that is the right behaviour on a narrow viewport where a panel is
 * genuinely hidden, but it also means renaming an id in index.html would
 * quietly gut the tour with nothing failing anywhere. These check the
 * selectors against the actual shell.
 */
// `?raw` rather than node:fs so the suite needs no Node type packages -
// vite/client already types this, and the project keeps its dependency
// list to vite, vitest, typescript and mathlive.
import html from "../index.html?raw";
import { describe, expect, it } from "vitest";
import { STEPS } from "../src/ui/tour";

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

describe("guided tour", () => {
  it("every target is an element that exists in the page shell", () => {
    const targets = STEPS.map((s) => s.target).filter((t): t is string => !!t);
    expect(targets.length).toBeGreaterThan(0);
    for (const sel of targets) {
      expect(sel.startsWith("#"), `${sel} should be an id selector`).toBe(true);
      expect(ids.has(sel.slice(1)), `${sel} is missing from index.html`).toBe(true);
    }
  });

  it("opens with an unanchored welcome and stays a short read", () => {
    expect(STEPS[0].target).toBeUndefined(); // centred, nothing to point at
    expect(STEPS.length).toBeLessThanOrEqual(8); // a tour, not a manual
    for (const s of STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      // one idea per step: long enough to be useful, short enough to read
      const words = s.body.trim().split(/\s+/).length;
      expect(words, `"${s.title}" is ${words} words`).toBeLessThanOrEqual(60);
      expect(words).toBeGreaterThan(10);
    }
  });

  it("never mentions keys or hover in the touch wording", () => {
    for (const s of STEPS) {
      if (s.touchBody === undefined) continue;
      expect(s.touchBody).not.toMatch(/\bcursor\b|right-drag|middle-drag|\bhover\b|spacebar/i);
    }
  });

  it("leaves the simulation paused by the time it finishes", () => {
    // the last step that touches playback must not leave it running: the
    // tour restores the entry state on finish, but a half-finished tour
    // that is skipped should not strand the user in a running scene
    const playbackSteps = STEPS.filter((s) => s.enter !== undefined);
    expect(playbackSteps.length).toBeGreaterThan(0);
    const app = { playing: false } as { playing: boolean };
    for (const s of STEPS) s.enter?.(app as never);
    expect(app.playing).toBe(false);
  });
});
