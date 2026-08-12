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
import { Driver } from "../src/engine/world";
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

  it("counts deleted bodies independently from cascading links", () => {
    const { app, panel, inspector } = makeInspector();
    const a = new Body(new Vec2(-1, 0), 0.2, 1);
    const b = new Body(new Vec2(0, 0), 0.2, 1);
    const c = new Body(new Vec2(1, 0), 0.2, 1);
    app.world.bodies.push(a, b, c);
    app.world.links.push(new DistanceLink(a, b), new DistanceLink(b, c));
    inspector.refresh();
    expect(rendered(panel)).toContain("Delete all 3 bodies");

    // Removing b also removes its two attached rods: three total objects go,
    // but the body counter must fall by exactly one.
    app.controller.deleteObjects([b]);
    inspector.refresh();
    expect(rendered(panel)).toContain("Delete all 2 bodies");
    expect(app.world.bodies).toHaveLength(2);
    expect(app.world.links).toHaveLength(0);
  });
});

describe("Inspector accessibility and persisted visibility", () => {
  it("wires tabs, their panel, reopen control and splitter semantics", () => {
    const { panel } = makeInspector();
    panel.id = "inspector";
    const tablist = panel.querySelector<HTMLElement>("[role=tablist]");
    const tabs = [...panel.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const tabpanel = panel.querySelector<HTMLElement>("[role=tabpanel]");
    const reopen = panel.querySelector<HTMLButtonElement>("button.reopen-strip");
    const splitter = document.body.querySelector<HTMLElement>("[role=separator]");

    expect(tablist?.getAttribute("aria-label")).toBe("Inspector sections");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected"),
                              tab.tabIndex]))
      .toEqual([["Selection", "true", 0], ["World", "false", -1],
                ["View", "false", -1]]);
    expect(tabpanel?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(reopen?.getAttribute("aria-controls")).toBe("inspector");
    expect(reopen?.getAttribute("aria-expanded")).toBe("true");
    expect(splitter?.getAttribute("aria-orientation")).toBe("vertical");
    expect(splitter?.getAttribute("aria-label")).toBe("Resize Inspector");
  });

  it("honours and updates the desktop visibility preference", () => {
    document.body.replaceChildren();
    const canvas = stubCanvas();
    const panel = document.createElement("aside");
    panel.id = "inspector";
    const splitter = document.createElement("div");
    document.body.append(canvas, panel, splitter);
    const app = new App(canvas);
    app.settings.inspector_visible = false;
    const inspector = new Inspector(app, panel, splitter);

    expect(panel.classList.contains("collapsed")).toBe(true);
    const reopen = panel.querySelector<HTMLButtonElement>("button.reopen-strip")!;
    expect(reopen.hidden).toBe(false);
    expect(reopen.getAttribute("aria-expanded")).toBe("false");
    inspector.toggleCollapsed();
    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(app.settings.inspector_visible).toBe(true);
    expect(JSON.parse(localStorage.getItem("mechanica.settings") ?? "{}")
      .inspector_visible).toBe(true);
  });

  it("names the icon-only control that removes a world driver", () => {
    const { app, panel } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.name = "Runner";
    app.world.bodies.push(body);
    app.world.drivers.push(new Driver(body.id));

    const worldTab = [...panel.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find((tab) => tab.textContent === "World")!;
    worldTab.click();

    const remove = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove driver for Runner"]');
    expect(remove).not.toBeNull();
    expect(remove?.title).toBe("Remove driver for Runner");
  });

  it("disables unavailable solver and trail controls in Performance mode", () => {
    const { app, panel, inspector } = makeInspector();
    const tab = (name: string): HTMLButtonElement =>
      [...panel.querySelectorAll<HTMLButtonElement>("[role=tab]")]
        .find((button) => button.textContent === name)!;

    app.view.trails = true;
    app.setPerfMode(true);

    tab("World").click();
    inspector.refresh();
    expect(panel.textContent).toContain("Performance mode is active");
    expect(panel.textContent).toContain(
      "Solver settings cannot be set in performance mode.");
    expect(panel.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="Substeps"]')?.disabled).toBe(true);

    tab("View").click();
    inspector.refresh();
    const motionLabel = [...panel.querySelectorAll<HTMLLabelElement>("label.checkbox")]
      .find((label) => label.textContent?.includes("Motion trails"))!;
    const motion = motionLabel.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(panel.textContent).toContain(
      "Motion trails are not available in performance mode.");
    expect(motion.disabled).toBe(true);
    expect(motion.checked).toBe(true); // Normal-mode preference is preserved
    expect(motionLabel.classList.contains("disabled")).toBe(true);
    expect(panel.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="Trail length"]')?.disabled).toBe(true);
  });
});

describe("Inspector edit transactions", () => {
  it("captures a delayed text commit after intervening simulation", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.name = "Runner";
    body.vel.x = 2;
    app.world.gravity = 0;
    app.world.bodies.push(body);
    app.undoStack.reset(app.world);
    app.setSelection([body]);
    inspector.refresh();

    const name = panel.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    name.focus();
    name.value = "Renamed";
    name.dispatchEvent(new Event("input", { bubbles: true }));

    app.world.step(0.25);
    const evolvedX = body.pos.x;
    expect(evolvedX).toBeGreaterThan(0);
    name.blur();
    expect(body.name).toBe("Renamed");

    app.undo();
    expect(app.world.bodies[0].name).toBe("Runner");
    expect(app.world.bodies[0].pos.x).toBeCloseTo(evolvedX, 12);
  });
});
