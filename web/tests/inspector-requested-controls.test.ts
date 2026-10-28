/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { Vec2 } from "../src/core/vec";
import { Inspector } from "../src/ui/inspector";

beforeEach(() => { localStorage.clear(); document.body.replaceChildren(); });
function fixture() {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  canvas.getContext = (() => ({ setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {} })) as unknown as HTMLCanvasElement["getContext"];
  const panel = document.createElement("aside"), splitter = document.createElement("div");
  document.body.append(canvas, panel, splitter);
  const app = new App(canvas); app.newScene();
  return { app, panel, inspector: new Inspector(app, panel, splitter) };
}
function slopes() {
  const f = fixture();
  const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0.1); floor.name = "Left plane";
  const other = new Wall(new Vec2(3, 0), new Vec2(6, 0), 0.1); other.name = "Right plane";
  const side = new Wall(new Vec2(0, -2), new Vec2(0, 2), 0.1); side.name = "Corner wall";
  const left = new Body(new Vec2(-1, 0.25), 0.2); left.name = "Left load";
  const right = new Body(new Vec2(4, 0.25), 0.2); right.name = "Right load";
  const corner = new Body(new Vec2(0.25, 0.25), 0.2); corner.name = "Corner load";
  const free = new Body(new Vec2(10, 4), 0.2); free.name = "Airborne load";
  f.app.world.walls.push(floor, other, side); f.app.world.bodies.push(left, right, corner, free);
  f.app.undoStack.reset(f.app.world);
  f.app.setSelection([left, right, corner, free]); f.inspector.refresh();
  const toggle = () => f.panel.querySelector<HTMLInputElement>('[aria-label="Resolve weight on slope"]')!;
  return { ...f, floor, other, side, left, right, corner, free, toggle };
}

describe("always-visible resultant", () => {
  it("settles force-readout visibility synchronously when its diagram toggle changes", () => {
    const f = fixture(), body = new Body(new Vec2(0, 1), .2, 2);
    f.app.world.bodies.push(body); f.app.setSelection([body]); f.inspector.refresh();
    f.app.undoStack.reset(f.app.world);
    const before = f.app.world.toDict();
    const toggle = f.panel.querySelector<HTMLInputElement>('[aria-label="Free-body forces on canvas"]')!;
    const readout = f.panel.querySelector<HTMLElement>(".force-readout")!;
    expect(readout.hidden).toBe(true);
    toggle.click();
    expect(readout.hidden).toBe(false);
    expect(readout.querySelector('[aria-label="Resultant force"]')!.textContent).toContain("Fy");
    toggle.click(); expect(readout.hidden).toBe(true);
    expect(f.app.world.toDict()).toEqual(before); expect(f.app.undoStack.canUndo).toBe(false);
  });
  it("labels measured forces as sustained only while captured impulses are separated", () => {
    const f = fixture(), body = new Body(new Vec2(0, .2499), .2, 2);
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1);
    f.app.world.gravity = 0; f.app.world.substeps = 8;
    body.vel.y = -2; body.restitution = floor.restitution = 1;
    body.showForceComponents = true; f.app.world.bodies.push(body); f.app.world.walls.push(floor);
    f.app.world.step(.01); f.app.setSelection([body]); f.inspector.refresh();
    expect(f.panel.querySelector(".force-interval-note")!.textContent).toContain("Sustained forces:");
    body.showCollisionImpulses = false; f.inspector.refresh();
    expect(f.panel.querySelector(".force-interval-note")!.textContent).toContain("Average forces:");
  });
  it("updates without opening force sources and exists once when expanded", () => {
    const f = fixture(), body = new Body(new Vec2(), 0.2, 1);
    body.showForceComponents = true; f.app.world.bodies.push(body);
    f.app.setSelection([body]); f.inspector.refresh();
    const details = f.panel.querySelector<HTMLDetailsElement>(".force-values")!;
    const result = f.panel.querySelector<HTMLElement>('[aria-label="Resultant force"]')!;
    expect(details.open).toBe(false); expect(result.closest("details")).toBeNull();
    expect(result.textContent).toContain(`Fy ${(-f.app.world.gravity).toFixed(2)} N`);
    body.constForce.x = 3; f.inspector.refresh(); expect(result.textContent).toContain("Fx 3.00 N");
    details.open = true; f.inspector.refresh();
    expect(f.panel.querySelectorAll(".force-resultant")).toHaveLength(1);
    details.open = false; body.constForce.x = 4; f.inspector.refresh();
    expect(result.textContent).toContain("Fx 4.00 N");
  });
});

describe("rod assembly navigation and preserved analysis", () => {
  it("lists visible components above controls and navigates between rod, loads and pivot without editing physics", async () => {
    const f = fixture(), { world } = f.app;
    const a = new Body(new Vec2(-2, 0)), b = new Body(new Vec2(2, 0));
    a.isRodEndpoint = b.isRodEndpoint = true;
    const rod = new DistanceLink(a, b, 4); rod.name = "Beam";
    const left = new Body(new Vec2(-1, 0)), right = new Body(new Vec2(2, 0)), pivot = new Body(new Vec2());
    left.name = "Left"; right.name = "Right"; pivot.name = "Pivot";
    for (const [member, t] of [[left, .25], [right, 1], [pivot, .5]] as const) {
      member.rodAttachmentId = rod.id; member.rodAttachmentT = t;
    }
    pivot.locked = pivot.isAnchor = pivot.isPivot = true;
    world.bodies.push(a, b, left, right, pivot); world.links.push(rod);
    left.showForceComponents = true; world.step(.001);
    const source = left.forceSnapshot, before = world.toDict();
    f.app.setSelection([rod]); f.inspector.refresh();
    const group = () => f.panel.querySelector<HTMLElement>('.rod-assembly')!;
    expect(group().querySelectorAll('button')).toHaveLength(4);
    expect(group().textContent).not.toContain('Rod endpoint');
    const click = (name: string) => { f.panel.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click(); f.inspector.refresh(); };
    click('Select rod particle: Left'); expect(f.app.selection).toEqual([left]);
    expect(group().querySelector('[aria-current=true]')!.textContent).toContain('Left');
    const sibling = group().querySelector<HTMLButtonElement>('[aria-label="Select rod particle: Right"]')!;
    sibling.focus(); f.inspector.refresh(); expect(document.activeElement).toBe(sibling);
    click('Select rod anchor: Pivot'); expect(f.app.selection).toEqual([pivot]);
    click('Select rod: Beam'); expect(f.app.selection).toEqual([rod]);
    expect(world.toDict()).toEqual(before); expect(left.forceSnapshot).toBe(source);
    await Promise.resolve(); expect(left.forceSnapshot).toBe(source);
    click('Select rod particle: Left');
    f.panel.querySelector<HTMLButtonElement>('[aria-label="Hide Inspector"]')!.click();
    await Promise.resolve(); expect(left.forceSnapshot).toBe(source);
    f.inspector.toggleCollapsed(); f.inspector.refresh();
    const diagram = f.panel.querySelector<HTMLInputElement>('[aria-label="Free-body forces on canvas"]')!;
    diagram.click(); diagram.click(); await Promise.resolve();
    expect(left.forceSnapshot).toBe(source);
    const moments = [...f.panel.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .find(input => input.closest('label')?.textContent?.includes('Rod moments'))!;
    moments.click(); f.inspector.refresh();
    expect(f.panel.querySelector('.force-moments')!.textContent).toContain('Moments about Pivot');
    expect(f.panel.querySelector('.force-moments')!.textContent).toContain('N·m');
    expect(left.forceSnapshot).toBe(source);
    const assembly = group();
    rod.name = "Renamed beam"; f.inspector.refresh();
    expect(group()).toBe(assembly);
    expect(assembly.getAttribute("aria-label")).toBe("Rod assembly: Renamed beam");
    expect(assembly.querySelector('[aria-label="Select rod: Renamed beam"]')).not.toBeNull();
  });
});

describe("group weight resolution", () => {
  it("uses a retained themed choice for a single corner particle and closes it on selection replacement", () => {
    const f = slopes(); f.app.setSelection([f.corner]); f.inspector.refresh();
    const before = f.app.world.toDict();
    f.toggle().click(); f.inspector.refresh();
    const choice = f.panel.querySelector<HTMLButtonElement>('[aria-label="Resolve forces relative to a slope"]')!;
    expect(choice.tagName).toBe("BUTTON");
    expect(choice.getAttribute("role")).toBe("combobox");
    choice.focus(); choice.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(f.corner.forceSlopeWallId).toBe(f.side.id);
    expect(document.activeElement).toBe(choice);
    expect(f.app.world.toDict()).toEqual(before);
    f.side.name = "Renamed contact"; f.inspector.refresh();
    const renamed = f.app.world.toDict();
    expect(choice.textContent).toContain("Renamed contact");
    expect(f.panel.querySelector('[aria-label="Resolve forces relative to a slope"]')).toBe(choice);
    choice.click(); expect(choice.getAttribute("aria-expanded")).toBe("true");
    f.app.setSelection([f.right]); f.inspector.refresh();
    expect(choice.getAttribute("aria-expanded")).toBe("false");
    expect(choice.isConnected).toBe(false);
    expect(f.app.world.toDict()).toEqual(renamed);
    expect(f.app.undoStack.canUndo).toBe(false);
  });
  it("resolves each sole contact independently, leaves ambiguous choices explicit and preserves the physical model", () => {
    const f = slopes(); const before = f.app.world.toDict();
    f.toggle().click(); f.inspector.refresh();
    expect(f.left.forceSlopeWallId).toBe(f.floor.id); expect(f.right.forceSlopeWallId).toBe(f.other.id);
    expect(f.corner.forceSlopeWallId).toBeNull(); expect(f.free.forceSlopeWallId).toBeNull();
    expect([f.left, f.right, f.corner, f.free].every(body => body.resolveWeightOnSlope && body.showForceComponents)).toBe(true);
    const choices = f.panel.querySelectorAll<HTMLButtonElement>('.group-weight-reference [role=combobox]');
    const visible = [...choices].filter(choice => !choice.closest<HTMLElement>(".group-weight-reference")!.hidden);
    expect(visible).toHaveLength(1); expect(visible[0].getAttribute("aria-label")).toBe("Slope reference for Corner load");
    expect([...visible[0].parentElement!.querySelectorAll<HTMLElement>("[role=option]")].map(option => option.dataset.value)).toEqual(["", String(f.floor.id), String(f.side.id)]);
    expect(f.panel.querySelector(".group-weight-note")!.textContent).toContain("Only weight");
    expect(f.app.world.toDict()).toEqual(before); expect(f.app.undoStack.canUndo).toBe(false);
    f.toggle().click(); f.inspector.refresh();
    expect([f.left, f.right, f.corner, f.free].every(body => !body.resolveWeightOnSlope && body.forceSlopeWallId === null)).toBe(true);
    expect([f.left, f.right, f.corner, f.free].every(body => body.showForceComponents)).toBe(true);
  });
  it("shows mixed state, retains a valid per-particle choice and follows contact changes without replacing focused controls", () => {
    const f = slopes(); f.corner.resolveWeightOnSlope = true; f.corner.forceSlopeWallId = f.side.id; f.inspector.refresh();
    expect(f.toggle().indeterminate).toBe(true); f.toggle().click(); f.inspector.refresh();
    expect(f.toggle().indeterminate).toBe(false); expect(f.toggle().checked).toBe(true);
    expect(f.corner.forceSlopeWallId).toBe(f.side.id);
    const choice = f.panel.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Slope reference for Corner load"]')!;
    choice.focus(); f.side.name = "Renamed corner"; f.inspector.refresh();
    expect(document.activeElement).toBe(choice); expect(choice.parentElement!.querySelectorAll("[role=option]")[2].textContent).toBe("Renamed corner");
    choice.click(); choice.parentElement!.querySelector<HTMLElement>(`[role=option][data-value="${f.floor.id}"]`)!.click();
    expect(f.corner.forceSlopeWallId).toBe(f.floor.id);
    f.corner.pos.x = 1; f.free.pos.set(4, 0.25); f.inspector.refresh();
    expect(f.corner.forceSlopeWallId).toBe(f.floor.id); expect(f.free.forceSlopeWallId).toBe(f.other.id);
    f.left.pos.y = 2; f.inspector.refresh(); expect(f.left.forceSlopeWallId).toBeNull();
    expect(f.left.resolveWeightOnSlope).toBe(true);
    expect(f.panel.querySelector('[aria-label="Slope reference for Corner load"]')).toBe(choice);
  });
  it("changes selected particles only, excluding anchors and rod endpoints in a mixed selection", () => {
    const f = slopes(); const anchor = new Body(new Vec2()); anchor.isAnchor = anchor.locked = true;
    const endpoint = new Body(new Vec2()); endpoint.isRodEndpoint = true;
    f.app.world.bodies.push(anchor, endpoint); f.app.setSelection([f.left, anchor, endpoint, f.floor]); f.inspector.refresh();
    f.toggle().click(); f.inspector.refresh();
    expect(f.left.resolveWeightOnSlope).toBe(true);
    expect([f.right, f.corner, f.free, anchor, endpoint].every(body => !body.resolveWeightOnSlope && !body.showForceComponents)).toBe(true);
  });
  it("retains the toggle as contact appears and closes a corner choice safely when selection changes", () => {
    const f = slopes(); f.app.setSelection([f.free, f.right]); f.right.pos.y = 3; f.inspector.refresh();
    const toggle = f.toggle(); expect(toggle.disabled).toBe(true);
    f.right.pos.y = 0.25; f.inspector.refresh(); expect(f.toggle()).toBe(toggle); expect(toggle.disabled).toBe(false);
    toggle.click(); f.inspector.refresh(); expect(f.right.forceSlopeWallId).toBe(f.other.id);
    f.app.setSelection([f.left, f.corner]); f.inspector.refresh(); f.toggle().click(); f.inspector.refresh();
    const choice = f.panel.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Slope reference for Corner load"]')!;
    choice.click(); expect(choice.getAttribute("aria-expanded")).toBe("true");
    f.app.setSelection([f.left]); f.inspector.refresh();
    expect(choice.getAttribute("aria-expanded")).toBe("false"); expect(choice.isConnected).toBe(false);
  });
  it.each([0, 1, 2, 3])("retains group choices and disables analysis in Performance tier %s", level => {
    const f = slopes(); f.toggle().click(); f.inspector.refresh();
    f.app.setPerfMode(true); (f.app as unknown as { setPerformanceLevel(n: number): void }).setPerformanceLevel(level); f.inspector.refresh();
    expect(f.toggle().disabled).toBe(true); f.toggle().click();
    expect(f.panel.querySelector<HTMLInputElement>('[aria-label="Free-body forces on canvas"]')!.disabled).toBe(true);
    expect([...f.panel.querySelectorAll<HTMLButtonElement>('.group-weight-reference [role=combobox]')].every(input => input.disabled)).toBe(true);
    expect(f.left.resolveWeightOnSlope).toBe(true); expect(f.left.forceSlopeWallId).toBe(f.floor.id);
    f.app.setPerfMode(false); f.inspector.refresh(); expect(f.toggle().disabled).toBe(false);
    expect(f.toggle().checked).toBe(true); expect(f.left.forceSlopeWallId).toBe(f.floor.id);
  });
});

describe("Event history presentation", () => {
  it("keeps accessible Show, Hide and Clear controls together and clears only the recorded rows", () => {
    const f = fixture();
    const world = [...f.panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === "World")!;
    world.click(); f.inspector.refresh();
    const head = f.panel.querySelector<HTMLElement>(".event-history-header")!;
    const toggle = head.querySelector<HTMLButtonElement>(".event-history-toggle")!;
    const clear = head.querySelector<HTMLButtonElement>('[aria-label="Clear history"]')!;
    const history = f.panel.querySelector<HTMLElement>(".event-history")!;
    expect(clear).not.toBeNull(); expect(clear.hidden).toBe(true); expect(toggle.getAttribute("aria-controls")).toBe(history.id);
    toggle.click(); f.inspector.refresh(); expect(history.hidden).toBe(false); expect(clear.hidden).toBe(false); expect(clear.disabled).toBe(true);
    expect(history.querySelector(".event-history-empty strong")?.textContent).toBe("No events yet");
    expect(history.querySelector(".event-history-empty p")?.textContent).toContain("Play or step");
    f.app.playbackEvents.events.push({ id: 1, kind: "contact", time: 0.5, label: "Contact began", bodyIds: [], value: "Test contact" });
    f.inspector.refresh(); expect(clear.disabled).toBe(false); expect(history.querySelectorAll(".inspector-event-row")).toHaveLength(1);
    const before = f.app.world.toDict(); clear.click(); f.inspector.refresh();
    expect(f.app.playbackEvents.events).toEqual([]); expect(f.app.world.toDict()).toEqual(before);
    expect(clear.disabled).toBe(true); toggle.click(); expect(history.hidden).toBe(true); expect(clear.hidden).toBe(true);
  });
});

describe("Hooke-law formula presentation", () => {
  it.each([1, 2])("typesets force and energy for %s links without the removed damping action or note", count => {
    const f = fixture(); const a = new Body(new Vec2()), b = new Body(new Vec2(3, 0));
    f.app.world.bodies.push(a, b);
    const links = Array.from({ length: count }, () => new SpringLink(a, b, 2, 10, 2, true));
    f.app.world.links.push(...links); f.app.setSelection(links); f.inspector.refresh();
    const card = f.panel.querySelector(".elastic-model")!;
    expect([...card.querySelectorAll("button")].some(button => button.textContent === "Set damping to zero")).toBe(false);
    expect(card.textContent).not.toContain("Set damping to zero for an ideal elastic model");
    expect(card.textContent).not.toContain("Ideal values exclude damping and solver limits");
    const formulas = card.querySelectorAll<HTMLElement>('[role="math"]'); expect(formulas).toHaveLength(2);
    expect(formulas[0].getAttribute("aria-label")).toContain("F equals k times x");
    expect(formulas[1].getAttribute("aria-label")).toContain("one half k times x squared");
    expect(formulas[0].querySelectorAll("mfrac")).toHaveLength(1); expect(formulas[1].querySelectorAll("mfrac")).toHaveLength(2);
    expect(formulas[1].querySelectorAll("msup")).toHaveLength(2);
    expect(links.map(link => link.damping)).toEqual(Array(count).fill(2));
    expect(card.querySelector('input[aria-label="Modulus λ (N)"]')).not.toBeNull();
  });
});


describe("pulley wheel and string vector controls", () => {
  function assembly() {
    const f = fixture();
    const a = new Body(new Vec2(-1, 0)), b = new Body(new Vec2(1, 0)), wheel = new Body(new Vec2(0, 2));
    const link = new PulleyLink(a, b, wheel); f.app.world.bodies.push(a, b, wheel); f.app.world.links.push(link);
    return { ...f, a, b, wheel, link };
  }
  it("toggles the wheel resultant immediately and independently from the two string legs", () => {
    const f = assembly(); f.link.showTensionVectors = true;
    f.app.setSelection([f.wheel]); f.inspector.refresh();
    expect(f.panel.querySelector(".pulley-readout")).toBeNull();
    const result = f.panel.querySelector<HTMLInputElement>('[aria-label="Resultant tension vector"]')!;
    const redraw = vi.spyOn(f.app, "invalidateCanvas");
    result.click(); expect(f.link.showResultantTensionVector).toBe(true); expect(f.link.showTensionVectors).toBe(true);
    expect(redraw).toHaveBeenCalled(); expect(f.app.world.time).toBe(0);
    f.app.setSelection([f.link]); f.inspector.refresh();
    const legs = [...f.panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.closest("label")!.textContent === "Tension vectors")!;
    expect(legs.checked).toBe(true); legs.click(); expect(f.link.showTensionVectors).toBe(false);
    expect(f.link.showResultantTensionVector).toBe(true); redraw.mockRestore();
  });
  it("shows a mixed wheel group and changes only resultants, retaining all string preferences", () => {
    const f = assembly(); const a = new Body(new Vec2(3, 0)), b = new Body(new Vec2(5, 0)), wheel = new Body(new Vec2(4, 2));
    const other = new PulleyLink(a, b, wheel); f.app.world.bodies.push(a, b, wheel); f.app.world.links.push(other);
    f.link.showResultantTensionVector = true; f.link.showTensionVectors = true;
    f.app.setSelection([f.wheel, wheel]); f.inspector.refresh();
    const result = f.panel.querySelector<HTMLInputElement>('[aria-label="Resultant tension vector"]')!;
    expect(result.indeterminate).toBe(true); result.click(); f.inspector.refresh();
    expect(result.indeterminate).toBe(false); expect([f.link, other].every(link => link.showResultantTensionVector)).toBe(true);
    expect([f.link.showTensionVectors, other.showTensionVectors]).toEqual([true, false]);
    result.click(); f.inspector.refresh(); expect([f.link, other].some(link => link.showResultantTensionVector)).toBe(false);
    expect([f.link.showTensionVectors, other.showTensionVectors]).toEqual([true, false]);
  });

  it("retains independent vector choices through reset and tab presentation restoration", () => {
    const f = assembly();
    f.app.pushUndo();
    f.app.stepOnce();
    let link = f.app.world.links[0] as PulleyLink;
    link.showResultantTensionVector = true; link.showTensionVectors = false;
    const presentation = f.app.tabRecoveryState().presentation;
    f.app.resetSim(); link = f.app.world.links[0] as PulleyLink;
    expect(link.showResultantTensionVector).toBe(true); expect(link.showTensionVectors).toBe(false);
    link.showResultantTensionVector = false; link.showTensionVectors = true;
    f.app.restoreTabPresentation(presentation);
    expect(link.showResultantTensionVector).toBe(true); expect(link.showTensionVectors).toBe(false);
    f.app.restoreTabPresentation({ links: [[`p:${link.id}`, true]] });
    expect(link.showResultantTensionVector).toBe(true);
  });
  it("keeps paused measured forces when changing wheel and string presentation", () => {
    const f = assembly(); f.a.showForceComponents = f.b.showForceComponents = true;
    f.app.stepOnce();
    const measuredA = f.a.forceSnapshot, measuredB = f.b.forceSnapshot, time = f.app.world.time;
    expect(measuredA).not.toBeNull(); expect(measuredB).not.toBeNull();
    f.app.setSelection([f.wheel]); f.inspector.refresh();
    f.panel.querySelector<HTMLInputElement>('[aria-label="Resultant tension vector"]')!.click();
    expect(f.a.forceSnapshot).toBe(measuredA); expect(f.b.forceSnapshot).toBe(measuredB);
    f.app.setSelection([f.link]); f.inspector.refresh();
    [...f.panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.closest("label")!.textContent === "Tension vectors")!.click();
    expect(f.a.forceSnapshot).toBe(measuredA); expect(f.b.forceSnapshot).toBe(measuredB);
    expect(f.app.world.time).toBe(time);
  });
});
