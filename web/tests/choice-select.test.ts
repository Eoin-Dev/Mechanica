/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { choiceSelect } from "../src/ui/choice-select";
import type { Control } from "../src/ui/dom";
let control: Control;
function setup() {
  let value = "Off", disabled = false;
  const choices = [{ value: "Off", label: "Off" }, { value: "Energy", label: "Energy" },
    { value: "Velocity", label: "Velocity–time" }];
  control = choiceSelect("Graph", () => choices, () => value, next => { value = next; }, { disabled: () => disabled });
  document.body.replaceChildren(control.root);
  const trigger = control.root.querySelector<HTMLButtonElement>("[role=combobox]")!;
  return { trigger, choices, value: () => value, external: (next: string) => { value = next; control.refresh!(); },
    disable: () => { disabled = true; control.refresh!(); },
    key: (key: string) => trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })) };
}
afterEach(() => { control?.dispose?.(); document.body.replaceChildren(); });
describe("themed select-only combobox", () => {
  it("retains focus and changes exactly one selected value on pointer activation", () => {
    const s = setup(); s.trigger.focus(); s.trigger.click();
    expect(s.trigger.getAttribute("aria-expanded")).toBe("true");
    control.root.querySelector<HTMLElement>('[data-value="Velocity"]')!.click();
    expect(s.value()).toBe("Velocity"); expect(s.trigger.textContent).toBe("Velocity–time");
    expect(document.activeElement).toBe(s.trigger); expect(s.trigger.getAttribute("aria-expanded")).toBe("false");
    s.external("Energy"); expect(s.trigger.textContent).toBe("Energy"); expect(document.activeElement).toBe(s.trigger);
  });
  it("offers arrow, boundary and type-ahead navigation with Escape cancellation", () => {
    const s = setup(); s.trigger.focus(); s.key("ArrowDown"); s.key("End"); s.key("Enter");
    expect(s.value()).toBe("Velocity"); s.key("Enter"); s.key("Home"); s.key("Escape");
    expect(s.value()).toBe("Velocity"); expect(s.trigger.hasAttribute("aria-activedescendant")).toBe(false);
    s.key("e"); s.key("Enter"); expect(s.value()).toBe("Energy");
  });
  it("closes on outside press, focus departure, disposal and dynamic disable", () => {
    const s = setup(); s.trigger.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.trigger.getAttribute("aria-expanded")).toBe("false");
    s.trigger.click(); s.disable(); expect(s.trigger.disabled).toBe(true);
    expect(s.trigger.getAttribute("aria-expanded")).toBe("false");
    s.trigger.click(); expect(s.trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("updates labels without replacing the trigger or treating user text as markup", () => {
    const s = setup(); s.choices[0].label = '<img src=x onerror="alert(1)">'; control.refresh!();
    expect(control.root.querySelector("img")).toBeNull(); expect(s.trigger.textContent).toContain("<img");
    s.trigger.click(); expect(control.root.querySelector('[role="option"]')!.textContent).toContain("<img");
    s.key("Tab"); expect(s.trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it.each(["commit", "cancel"])("starts a new typeahead search after %s", action => {
    const s = setup();
    for (const key of ["v","e","l"]) s.key(key);
    s.key(action === "commit" ? "Enter" : "Escape");
    if (action === "commit") expect(s.value()).toBe("Velocity");
    s.key("e"); s.key("Enter");
    expect(s.value()).toBe("Energy");
  });
});
