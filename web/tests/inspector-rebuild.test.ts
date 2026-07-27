/** @vitest-environment jsdom */
/** The Inspector rebuilds exactly when what it is editing changes.
 *
 * The panel refreshes its controls in place every frame and only tears
 * itself down when a "structure key" changes. That key has to distinguish
 * every selection the panel would lay out differently - and object ids
 * restart at 1 for each kind, so body 3 and wall 3 are different selections
 * carrying the same number.
 *
 * The kind used to come from `constructor.name`, which works only until a
 * bundler renames the class. The production build DOES minify class names,
 * so the key was being built from whatever one-character name esbuild
 * assigned; consistent within a build, and therefore harmless so far, but
 * decided by the bundler rather than the program. The failure it would
 * produce is silent - a panel still showing a body's controls after a wall
 * is selected - so it is worth pinning by behaviour rather than trusting.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { Vec2 } from "../src/core/vec";
import { Inspector } from "../src/ui/inspector";

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getContext = (() => ({
    setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    closePath() {}, measureText: () => ({ width: 10 }), fillText() {},
    translate() {}, rotate() {}, scale() {}, setLineDash() {}, clip() {},
  })) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

function makeInspector(): { app: App; panel: HTMLElement; inspector: Inspector } {
  document.body.replaceChildren();
  const canvas = stubCanvas();
  const panel = document.createElement("aside");
  const splitter = document.createElement("div");
  document.body.append(canvas, panel, splitter);
  const app = new App(canvas);
  return { app, panel, inspector: new Inspector(app, panel, splitter) };
}

/** A fingerprint of what the panel currently shows. */
function rendered(panel: HTMLElement): string {
  return panel.textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
});

describe("Inspector structure key", () => {
  it("tells a body from a wall that shares its id", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    const wall = new Wall(new Vec2(-1, 0), new Vec2(1, 0));
    body.id = 3;
    wall.id = 3;
    app.world.bodies.push(body);
    app.world.walls.push(wall);

    app.setSelection([body]);
    inspector.refresh();
    const asBody = rendered(panel);

    app.setSelection([wall]);
    inspector.refresh();
    const asWall = rendered(panel);

    expect(asBody).not.toBe(asWall);
    // and the panel is really showing each one's own controls
    expect(asBody).toMatch(/Mass/i);
    expect(asWall).toMatch(/Thickness/i);
  });

  it("tells a spring from a rod that shares its id", () => {
    const { app, panel, inspector } = makeInspector();
    const a = new Body(new Vec2(0, 0), 0.2, 1);
    const b = new Body(new Vec2(1, 0), 0.2, 1);
    app.world.bodies.push(a, b);
    const spring = new SpringLink(a, b);
    const rod = new DistanceLink(a, b);
    spring.id = 7;
    rod.id = 7;
    app.world.links.push(spring, rod);

    app.setSelection([spring]);
    inspector.refresh();
    const asSpring = rendered(panel);

    app.setSelection([rod]);
    inspector.refresh();
    const asRod = rendered(panel);

    expect(asSpring).not.toBe(asRod);
    expect(asSpring).toMatch(/Stiffness/i);
  });

  it("does not rebuild while the selection is unchanged", () => {
    // the other half of the contract: rebuilding every frame would destroy
    // the control under the user's cursor mid-edit
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(body);
    app.setSelection([body]);
    inspector.refresh();
    const first = panel.querySelector(".inspector-body")?.firstElementChild;
    for (let i = 0; i < 5; i++) inspector.refresh();
    expect(panel.querySelector(".inspector-body")?.firstElementChild).toBe(first);
  });

  it("survives the selected object being deleted underneath it", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(body);
    app.setSelection([body]);
    inspector.refresh();
    app.world.removeBody(body);
    app.setSelection([]);
    expect(() => inspector.refresh()).not.toThrow();
    expect(rendered(panel)).not.toBe("");
  });
});
