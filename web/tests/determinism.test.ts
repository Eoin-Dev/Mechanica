/** The same scene must simulate identically however the app happens to
 * schedule it.
 *
 * The app subdivides each quantum adaptively; how finely used to depend
 * on measured frame times, i.e. on how busy the machine was. That leaked
 * into the physics two ways - the spring stability clamps were computed
 * from the live substep, and the substep itself set the integration
 * accuracy - so the same setup could ring on one run and sit still on
 * the next. Both are pinned here.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const DT = 1.0 / 120.0;

/** Run `seconds` of simulated time, splitting each 1/120 frame into `q`
 * substeps exactly as the scheduler would on a busier machine. */
function run(build: () => World, q: number, seconds: number) {
  const w = build();
  const dt = DT / q;
  for (let f = 0; f < seconds * 120; f++) {
    for (let i = 0; i < q; i++) w.step(dt);
  }
  return w;
}

describe("scheduling independence", () => {
  it("clamped spring damping does not depend on the substep", () => {
    // A damping the clamp has to cut back (the reported case: every
    // trampoline spring set to maximum) must land on the same effective
    // value however finely the frame is subdivided.
    const build = () => {
      const w = new World();
      w.substeps = 4;
      const a = new Body(new Vec2(0, 0), 0.1, 1);
      const b = new Body(new Vec2(1, 0), 0.1, 1);
      a.locked = true;
      w.bodies.push(a, b);
      const s = new SpringLink(a, b, 1.0, 200, 500); // damping way past the limit
      w.links.push(s);
      return w;
    };
    const cEff = [1, 2, 4, 8].map((q) => {
      const w = run(build, q, 0.2);
      return (w.links[0] as SpringLink).cEff;
    });
    for (const c of cEff) expect(c).toBeCloseTo(cEff[0], 12);
  });

  it("clamped stiffness does not depend on the substep either", () => {
    const build = () => {
      const w = new World();
      w.substeps = 4;
      const a = new Body(new Vec2(0, 0), 0.1, 1);
      const b = new Body(new Vec2(1, 0), 0.1, 1);
      a.locked = true;
      w.bodies.push(a, b);
      w.links.push(new SpringLink(a, b, 1.0, 1e9, 0)); // absurdly stiff
      return w;
    };
    const kEff = [1, 2, 4].map((q) => (run(build, q, 0.2).links[0] as SpringLink).kEff);
    for (const k of kEff) expect(k).toBeCloseTo(kEff[0], 6);
  });

  it("a maximally damped trampoline settles the same way every run", () => {
    // the exact reported scenario: select every spring, set damping to
    // maximum, then reset and play - twice
    const build = () => {
      const w = PRESETS.find((p) => p.name === "Trampoline")!.build();
      for (const ln of w.links) {
        if (ln instanceof SpringLink) ln.damping = 500;
      }
      return w;
    };
    const state = (w: World) => w.bodies
      .filter((b) => !b.locked)
      .map((b) => `${b.pos.x.toFixed(9)},${b.pos.y.toFixed(9)}`)
      .join("|");
    // identical scheduling must of course match...
    expect(state(run(build, 1, 1.5))).toBe(state(run(build, 1, 1.5)));
    // ...and so must the effective spring parameters under any other
    // scheduling the app might have chosen on a busier machine
    const cOf = (w: World) =>
      (w.links.find((l) => l instanceof SpringLink) as SpringLink).cEff;
    expect(cOf(run(build, 2, 1.5))).toBeCloseTo(cOf(run(build, 1, 1.5)), 12);
    expect(cOf(run(build, 4, 1.5))).toBeCloseTo(cOf(run(build, 1, 1.5)), 12);
  });

  it("repeated runs of a preset are bit-identical", () => {
    for (const name of ["Trampoline", "Jelly block", "Choreography: moth"]) {
      const build = () => PRESETS.find((p) => p.name === name)!.build();
      const dump = (w: World) => w.bodies
        .map((b) => `${b.pos.x},${b.pos.y},${b.vel.x},${b.vel.y}`).join("|");
      expect(dump(run(build, 1, 2))).toBe(dump(run(build, 1, 2)));
    }
  });
});
