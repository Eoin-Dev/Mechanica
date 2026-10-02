/** @vitest-environment jsdom */
/** Inspector structure keys must distinguish object kinds as well as IDs.
 * Refresh keeps the existing controls when the required layout is unchanged. */
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Body, PULLEY_PARTICLE_RADIUS, PULLEY_RADIUS, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { Driver, ForceField } from "../src/engine/world";
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

describe("Collision material guidance", () => {
  it.each(["body", "anchor", "wall"] as const)("explains relative restitution and the material rule for a %s", kind => {
    const { app, panel, inspector } = makeInspector();
    const item = kind === "wall" ? new Wall(new Vec2(-2, 0), new Vec2(2, 0))
      : new Body(new Vec2(0, 1));
    if (item instanceof Body) {
      item.isAnchor = kind === "anchor";
      app.world.bodies.push(item);
    } else app.world.walls.push(item);
    app.setSelection([item]);
    inspector.refresh();
    const input = panel.querySelector<HTMLInputElement>('[aria-label="Restitution e (type an exact value)"]');
    expect(input).not.toBeNull();
    const model = panel.querySelector(".collision-model")!;
    expect(model.textContent).toContain("lower");
    expect(model.textContent).toContain("relative");
    expect(model.textContent).toContain("not joined");
    expect(model.querySelector("summary")!.textContent).toBe("How impacts work");
  });

  it("updates the selected material pair without replacing its disclosure or focused control", () => {
    const { app, panel, inspector } = makeInspector();
    const a = new Body(new Vec2(-1, 0));
    const b = new Body(new Vec2(1, 0));
    a.restitution = 1;
    b.restitution = 0.6;
    app.world.bodies.push(a, b);
    app.setSelection([a, b]);
    inspector.refresh();
    const model = panel.querySelector(".collision-model")!;
    const details = model.querySelector("details")!;
    details.open = true;
    const field = panel.querySelector<HTMLInputElement>('[aria-label="Restitution e (type an exact value)"]')!;
    field.focus();
    expect(model.querySelector(".collision-pair")!.textContent).toBe("Material pair e = 0.6");
    b.restitution = 0.25;
    inspector.refresh();
    expect(model.querySelector(".collision-pair")!.textContent).toBe("Material pair e = 0.25");
    expect(panel.querySelector(".collision-model")).toBe(model);
    expect(model.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("shows one material rule for a mixed body and wall pair", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 1));
    const wall = new Wall(new Vec2(-2, 0), new Vec2(2, 0));
    body.restitution = 0.8;
    wall.restitution = 0.123456789;
    app.world.bodies.push(body);
    app.world.walls.push(wall);
    app.setSelection([body, wall]);
    inspector.refresh();
    expect(panel.querySelectorAll(".collision-model")).toHaveLength(1);
    expect(panel.querySelector(".collision-pair")!.textContent).toBe("Material pair e = 0.123456789");
    wall.restitution = 0.9;
    inspector.refresh();
    expect(panel.querySelector(".collision-pair")!.textContent).toBe("Material pair e = 0.8");
  });

  it.each(["two walls", "three bodies"] as const)("does not invent a single collision pair for %s", kind => {
    const { app, panel, inspector } = makeInspector();
    if (kind === "two walls") {
      app.world.walls.push(new Wall(new Vec2(-2, 0), new Vec2(2, 0)),
        new Wall(new Vec2(-2, 2), new Vec2(2, 2)));
      app.setSelection([...app.world.walls]);
    } else {
      app.world.bodies.push(...[-1, 0, 1].map(x => new Body(new Vec2(x, 1))));
      app.setSelection([...app.world.bodies]);
    }
    inspector.refresh();
    expect(panel.querySelectorAll(".collision-model")).toHaveLength(1);
    expect(panel.querySelector(".collision-pair")).toBeNull();
  });
});

describe("Elastic-link modulus", () => {
  it("accepts exam modulus and exposes extension, elastic force and energy", () => {
    const { app, panel, inspector } = makeInspector();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(2.5, 0), 0.1, 1);
    const link = new SpringLink(a, b, 2, 10, 0, true);
    app.world.bodies.push(a, b);
    app.world.links.push(link);
    app.undoStack.reset(app.world);
    app.setSelection([link]);
    inspector.refresh();
    const input = panel.querySelector<HTMLInputElement>('[aria-label="Modulus λ (N)"]');
    expect(input).not.toBeNull();
    input!.focus();
    input!.value = "60";
    input!.blur();
    inspector.refresh();
    expect(link.stiffness).toBe(30);
    expect(panel.querySelector(".elastic-model")!.textContent).toContain("15.00 N");
    expect(panel.querySelector(".elastic-model")!.textContent).toContain("3.75 J");
    expect(app.undoStack.canUndo).toBe(true);
    app.undo();
    expect((app.world.links[0] as SpringLink).stiffness).toBe(10);
    app.redo();
    expect((app.world.links[0] as SpringLink).stiffness).toBe(30);
  });

  function selectedLinks(lengths = [2, 4]) {
    const fixture = makeInspector();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(2.5, 0), 0.1, 1);
    const links = lengths.map(length => new SpringLink(a, b, length, 10, 2, true));
    fixture.app.world.bodies.push(a, b);
    fixture.app.world.links.push(...links);
    fixture.app.undoStack.reset(fixture.app.world);
    fixture.app.setSelection(links);
    fixture.inspector.refresh();
    const input = fixture.panel.querySelector<HTMLInputElement>('[aria-label="Modulus λ (N)"]')!;
    return { ...fixture, links, input, b };
  }

  it("identifies mixed moduli and applies a common modulus using each natural length", () => {
    const { app, panel, links, input, inspector } = selectedLinks();
    expect(input.value).toBe("Mixed");
    input.focus();
    input.value = "60";
    input.blur();
    inspector.refresh();
    expect(links.map(link => link.stiffness)).toEqual([30, 15]);
    expect(input.value).toBe("60");
    expect(panel.querySelector<HTMLDListElement>(".elastic-readings")!.hidden).toBe(true);
    app.undo();
    expect(app.world.links.map(link => (link as SpringLink).stiffness)).toEqual([10, 10]);
  });

  it.each([[60, 2, 3.7], [100, 0.3, 11]])("keeps common modulus %s readable across natural lengths %s and %s", (value, a, b) => {
    const { input, links, inspector } = selectedLinks([a, b]);
    input.focus();
    input.value = String(value);
    input.blur();
    inspector.refresh();
    expect(input.value).toBe(String(value));
    expect(links[0].stiffness).toBe(value / a);
    expect(links[1].stiffness).toBe(value / b);
  });

  it.each(["-2", "1e12", "2oops"])("retains rejected modulus %s without history or partial writes", async value => {
    const { app, links, input, inspector, panel } = selectedLinks([2, 1e-8]);
    input.focus();
    input.value = value;
    input.blur();
    await Promise.resolve();
    inspector.refresh();
    expect(links.map(link => link.stiffness)).toEqual([10, 10]);
    expect(input.value).toBe(value);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(panel.querySelector<HTMLElement>("#elastic-modulus-error")!.hidden).toBe(false);
    expect(app.undoStack.canUndo).toBe(false);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    inspector.refresh();
    expect(input.value).toBe("Mixed");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(panel.querySelector<HTMLElement>("#elastic-modulus-error")!.hidden).toBe(true);
  });

  it("disables modulus for zero natural length without losing the stiffness control", () => {
    const { input, links, inspector, panel } = selectedLinks([2, 0]);
    expect(input.disabled).toBe(true);
    expect(panel.textContent).toContain("Set a positive natural length");
    expect(panel.querySelector<HTMLInputElement>('[aria-label="Stiffness (type an exact value)"]')!.disabled).toBe(false);
    links[1].restLength = 4;
    inspector.refresh();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("Mixed");
  });

  it("retains a focused modulus draft as live geometry changes and keeps stiffness on length edits", () => {
    const { app, panel, inspector, input, links, b } = selectedLinks([2]);
    const card = panel.querySelector(".elastic-model");
    input.focus();
    input.value = "60";
    b.pos.x = 1.5;
    inspector.refresh();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("60");
    expect(panel.querySelector(".elastic-model")).toBe(card);
    expect(card!.textContent).toContain("slack");
    input.blur();
    const length = panel.querySelector<HTMLInputElement>('[aria-label="Natural length (type an exact value)"]')!;
    length.focus();
    length.value = "4";
    length.blur();
    inspector.refresh();
    expect(links[0].stiffness).toBe(30);
    expect(input.value).toBe("120");
    app.undo();
    expect((app.world.links[0] as SpringLink).restLength).toBe(2);
    expect((app.world.links[0] as SpringLink).stiffness).toBe(30);
  });

  it("removes damping as one reversible bulk edit and explains Performance approximations", () => {
    const { app, panel, inspector, links } = selectedLinks();
    const button = [...panel.querySelectorAll("button")].find(button => button.textContent === "Set damping to zero")!;
    expect(button.hidden).toBe(false);
    button.click();
    inspector.refresh();
    expect(links.map(link => link.damping)).toEqual([0, 0]);
    expect(button.hidden).toBe(true);
    app.undo();
    expect(app.world.links.map(link => (link as SpringLink).damping)).toEqual([2, 2]);
    app.setSelection(app.world.links);
    app.settings.perf_mode = true;
    inspector.refresh();
    expect(panel.querySelector(".elastic-model")!.textContent).toContain("Use Normal mode for quantitative study");
  });
});

describe("Force values and sources", () => {
  it("names individual forces, exposes signed components and retains the focused disclosure", () => {
    const { app, panel, inspector } = makeInspector();
    app.world.gravity = 9.8;
    const body = new Body(new Vec2(0, 0), 0.2, 2);
    body.constForce.set(3, -0.0004);
    body.showForceComponents = true;
    app.world.bodies.push(body);
    app.world.fields.push(new ForceField("<img src=x onerror=alert(1)>", "3", "0"));
    const wall = new Wall(new Vec2(-2, -2), new Vec2(2, -2));
    app.world.walls.push(wall);
    body.forceSlopeWallId = wall.id;
    app.setSelection([body]);
    inspector.refresh();
    const details = panel.querySelector<HTMLDetailsElement>(".force-values")!;
    details.open = true;
    inspector.refresh();
    const rows = [...details.querySelectorAll("li")];
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain("Applied force");
    expect(rows[1].textContent).toContain("Fy -4.00e-4 N");
    expect(rows[1].textContent).toContain("∥ 3.00 N⊥ -4.00e-4 N");
    expect(rows[2].textContent).toContain("<img src=x onerror=alert(1)>");
    expect(details.querySelector("img")).toBeNull();
    expect(rows[3].textContent).toContain("Resultant");
    expect(rows[3].textContent).toContain("Fx 6.00 NFy -19.60 N");
    details.querySelector("summary")!.focus();
    body.constForce.x = -10;
    inspector.refresh();
    expect(panel.querySelector(".force-values")).toBe(details);
    expect([...details.querySelectorAll("li")]).toEqual(rows);
    expect(rows[3].textContent).toContain("Fx -7.00 N");
    expect(document.activeElement).toBe(details.querySelector("summary"));
    expect(app.undoStack.canUndo).toBe(false);
  });

  it("shows every source in an overfull force diagram and hides with its view toggle", () => {
    const { app, panel, inspector } = makeInspector();
    app.world.gravity = 0;
    const body = new Body(new Vec2(0, 0));
    body.showForceComponents = true;
    app.world.bodies.push(body);
    for (let i = 0; i < 64; i++) app.world.fields.push(new ForceField(`Source ${i + 1}`, "3", "4"));
    app.setSelection([body]);
    inspector.refresh();
    const details = panel.querySelector<HTMLDetailsElement>(".force-values")!;
    expect(details.querySelectorAll("li")).toHaveLength(0);
    details.open = true;
    inspector.refresh();
    expect(details.querySelectorAll("li")).toHaveLength(65);
    expect(details.textContent).toContain("Source 64");
    expect(details.textContent).toContain("Fx 192.00 NFy 256.00 N");
    body.showForceComponents = false;
    inspector.refresh();
    expect(details.hidden).toBe(true);
    body.showForceComponents = true;
    inspector.refresh();
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(true);
  });

  it("uses recorded average forces in the text alternative to the diagram", () => {
    const { app, panel, inspector } = makeInspector();
    app.world.gravity = 0;
    app.world.integrator = "RK4";
    app.world.substeps = 1;
    const body = new Body(new Vec2(0, 0), 0.2, 2);
    body.showForceComponents = true;
    app.world.bodies.push(body);
    app.world.fields.push(new ForceField("Changing force", "120*t", "0"));
    app.setSelection([body]);
    app.world.step(1 / 60);
    inspector.refresh();
    const details = panel.querySelector<HTMLDetailsElement>(".force-values")!;
    details.open = true;
    inspector.refresh();
    expect(details.querySelectorAll("li")).toHaveLength(2);
    expect(details.textContent).toContain("Changing forceFx 1.00 N");
    expect(details.textContent).toContain("ResultantFx 1.00 N");
    expect(details.textContent).not.toContain("Fx 2.00 N");
    expect(body.forceSnapshot).not.toBeNull();
  });
});

describe("Pulley assembly navigation", () => {
  function assembly() {
    const fixture = makeInspector();
    const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
    const a = new Body(new Vec2(-0.22, -0.5), 0.2, 2);
    const b = new Body(new Vec2(0.22, -0.5), 0.2, 3);
    a.name = "Slope mass";
    b.name = "Hanging mass";
    const link = new PulleyLink(a, b, wheel);
    fixture.app.world.bodies.push(wheel, a, b);
    fixture.app.world.links.push(link);
    fixture.app.undoStack.reset(fixture.app.world);
    return { ...fixture, wheel, a, b, link };
  }

  it.each(["wheel", "link", "a", "b"] as const)("exposes all four parts from the selected %s", selected => {
    const fixture = assembly();
    const { app, panel, inspector, b } = fixture;
    app.setSelection([fixture[selected]]);
    inspector.refresh();
    const parts = [...panel.querySelectorAll<HTMLButtonElement>(".pulley-part")];
    expect(parts).toHaveLength(4);
    expect(parts.filter(part => part.disabled)).toHaveLength(1);
    expect(parts.find(part => part.disabled)?.getAttribute("aria-current")).toBe("true");
    const destination = selected === "b" ? fixture.a : b;
    parts.find(part => part.getAttribute("aria-label") ===
      `Select particle ${selected === "b" ? "A" : "B"}: ${destination.name}`)!.click();
    expect(app.selection).toEqual([destination]);
    expect(document.activeElement).toBe(panel.querySelector("[role=tabpanel]"));
    expect(app.undoStack.canUndo).toBe(false);
  });

  it("updates names and masses without replacing or defocusing navigation buttons", () => {
    const { app, panel, inspector, a, wheel } = assembly();
    app.setSelection([wheel]);
    inspector.refresh();
    const part = panel.querySelector<HTMLButtonElement>('[aria-label="Select particle A: Slope mass"]')!;
    part.focus();
    a.name = "<b>Mass 📐</b>";
    a.mass = 4;
    for (let i = 0; i < 5; i++) inspector.refresh();
    expect(document.activeElement).toBe(part);
    expect(part.textContent).toContain("<b>Mass 📐</b>");
    expect(part.textContent).toContain("4 kg");
    expect(part.querySelector("b")).toBeNull();
    expect(part.getAttribute("aria-label")).toBe("Select particle A: <b>Mass 📐</b>");
  });

  it("does not discard a recorded force interval when navigating the assembly", () => {
    const { app, panel, inspector, a, wheel } = assembly();
    a.showForceComponents = true;
    app.world.step(1 / 120);
    const snapshot = a.forceSnapshot;
    expect(snapshot).not.toBeNull();
    app.setSelection([wheel]);
    inspector.refresh();
    panel.querySelector<HTMLButtonElement>('[aria-label="Select particle A: Slope mass"]')!.click();
    expect(a.forceSnapshot).toBe(snapshot);
    expect(panel.textContent).toContain("Average forces:");
    expect(app.undoStack.canUndo).toBe(false);
  });

  it("removes stale assembly navigation when the string is removed under a selected particle", () => {
    const { app, panel, inspector, a, link } = assembly();
    app.setSelection([a]);
    inspector.refresh();
    expect(panel.querySelectorAll(".pulley-part")).toHaveLength(4);
    app.world.removeLink(link);
    inspector.refresh();
    expect(app.selection).toEqual([a]);
    expect(panel.querySelector(".pulley-part")).toBeNull();
    expect(panel.querySelector('input[aria-label="Radius"]')).not.toBeNull();
  });
});

describe("Inspector structure key", () => {
  it("explains current versus averaged force diagrams while retaining the focused checkbox", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 1), 0.2, 2);
    app.world.gravity = 0;
    app.world.bodies.push(body);
    app.world.fields.push(new ForceField("Ramping", "120*t", "0"));
    app.setSelection([body]);
    inspector.refresh();
    const checkbox = [...panel.querySelectorAll("label.checkbox")]
      .find(label => label.textContent === "Free-body forces on canvas")!.querySelector<HTMLInputElement>("input")!;
    const note = panel.querySelector<HTMLElement>(".force-interval-note")!;
    expect(note.hidden).toBe(true);
    checkbox.click();
    checkbox.focus();
    inspector.refresh();
    expect(note.textContent).toContain("Step once");
    app.world.step(1 / 60);
    inspector.refresh();
    expect(note.textContent).toContain("Average forces: 0.000–0.017 s");
    expect(note.textContent).toContain("C: numerical correction");
    expect(document.activeElement).toBe(checkbox);
    expect(panel.querySelector(".force-interval-note")).toBe(note);
    app.beginEdit();
    body.constForce.x = 3;
    app.commitEdit();
    inspector.refresh();
    expect(panel.querySelector(".force-interval-note")?.textContent).toContain("Current applied forces");
  });

  it("selects displacement from View and follows graph changes without replacing its control", () => {
    const { app, panel, inspector } = makeInspector();
    [...panel.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find(button => button.textContent === "View")!.click();
    inspector.refresh();
    const select = panel.querySelector<HTMLSelectElement>('[aria-label="Graph shown in the dock"]')!;
    expect([...select.options].find(option => option.value === "Displacement")?.text)
      .toBe("Displacement–time");
    select.focus();
    select.value = "Displacement";
    select.dispatchEvent(new Event("change"));
    expect(app.graphMode).toBe("Displacement");
    app.setGraphMode("Velocity");
    inspector.refresh();
    expect(panel.querySelector('[aria-label="Graph shown in the dock"]')).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe("Velocity");
  });

  it("keeps an attachment button focused through unchanged panel refreshes", () => {
    const { app, panel, inspector } = makeInspector();
    const a = new Body(new Vec2(0, 0));
    const b = new Body(new Vec2(2, 0));
    const attached = new Body(new Vec2(1, 0));
    const rod = new DistanceLink(a, b);
    attached.rodAttachmentId = rod.id;
    attached.rodAttachmentT = 0.5;
    app.world.bodies.push(a, b, attached);
    app.world.links.push(rod);
    app.setSelection([rod]);
    inspector.refresh();
    const button = panel.querySelector<HTMLButtonElement>(".rod-attachment-item")!;
    button.focus();
    for (let i = 0; i < 5; i++) inspector.refresh();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(app.selection).toEqual([attached]);
  });

  it("keeps a live pulley particle's system radius out of every edit route", () => {
    const { app, panel, inspector } = makeInspector();
    const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
    const a = new Body(new Vec2(-0.22, -0.5), 0.4, 1);
    const b = new Body(new Vec2(0.22, -0.5), 0.4, 1);
    const link = new PulleyLink(a, b, wheel);
    app.world.bodies.push(wheel, a, b);
    app.world.links.push(link);

    app.setSelection([a]);
    inspector.refresh();
    expect(panel.querySelector('input[aria-label="Radius"]')).toBeNull();

    app.clipboardProps = { radius: 2, mass: 3 };
    app.pasteProps();
    expect(a.radius).toBe(PULLEY_PARTICLE_RADIUS);
    expect(a.mass).toBe(3);

    const ordinary = new Body(new Vec2(2, 0), 0.25, 1);
    app.world.bodies.push(ordinary);
    app.setSelection([a, ordinary]);
    inspector.refresh();
    expect(panel.querySelector('input[aria-label="Radius"]')).not.toBeNull();
  });

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
  it("retains committed fields so subsequent edits cannot target detached controls", () => {
    const { app, panel, inspector } = makeInspector();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(body);
    app.undoStack.reset(app.world);
    app.setSelection([body]);
    inspector.refresh();
    const name = panel.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    const mass = panel.querySelector<HTMLInputElement>('[aria-label="Mass (type an exact value)"]')!;
    name.focus();
    name.value = "Renamed";
    name.blur();
    mass.focus();
    mass.value = "3";
    mass.dispatchEvent(new Event("input", { bubbles: true }));
    inspector.refresh();
    expect(panel.querySelector('[aria-label="Name"]')).toBe(name);
    expect(panel.querySelector('[aria-label="Mass (type an exact value)"]')).toBe(mass);
    expect(document.activeElement).toBe(mass);
    mass.blur();
    expect(body.mass).toBe(3);
    expect(body.name).toBe("Renamed");
    app.undo();
    expect(app.world.bodies[0].mass).toBe(1);
    expect(app.world.bodies[0].name).toBe("Renamed");
  });

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
