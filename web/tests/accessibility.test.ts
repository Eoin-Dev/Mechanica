/** @vitest-environment jsdom */
/** Every control the app builds must be usable without sight.
 *
 * A live audit of the running app found three things wrong, all of the same
 * shape: state and identity that reach the EYE but not assistive tech.
 *
 *   - `slider()` and `numEdit()` put their caption in a sibling <span>, not
 *     a <label for>, so nothing associated the two. The Inspector is built
 *     almost entirely out of these, so most of the app's controls announced
 *     as unlabelled.
 *   - A range input's value is a position on an internal 0..2000 track, and
 *     that is the number read out: a mass of 12 kg was announced as "1165".
 *   - Toggle buttons and segmented strips carried their selected state in a
 *     CSS class alone, so which tool was active, or which option chosen,
 *     was not exposed at all.
 *
 * These are asserted against the builders rather than against a rendered
 * page, so a new control gets them by construction.
 */
import { describe, expect, it } from "vitest";
import { button, checkbox, colourEdit, numEdit, segmented, slider,
         refreshTabs, textEdit, wireTabs } from "../src/ui/dom";

/** The name assistive tech would announce for a control. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  if (el.closest("label")) return (el.closest("label")?.textContent ?? "").trim();
  const title = el.getAttribute("title");
  if (title) return title;
  return (el.textContent ?? "").trim();
}

const SELECTOR = "input, button, select, textarea";

/** Focusable parts of a control. Some builders return a wrapper and some
 * return the field itself (textEdit does), so the root counts too. */
const focusable = (root: HTMLElement): Element[] => {
  const inner = [...root.querySelectorAll(SELECTOR)];
  return root.matches(SELECTOR) ? [root, ...inner] : inner;
};

describe("every control has an accessible name", () => {
  it("slider names both its track and its typed-value field", () => {
    const c = slider("Mass", () => 3, () => {}, 0.1, 100, { unit: "kg" });
    const inputs = focusable(c.root);
    expect(inputs.length).toBe(2);
    for (const el of inputs) {
      expect(accessibleName(el), el.getAttribute("type") ?? "").toContain("Mass");
    }
  });

  it("numEdit names its field, with the unit", () => {
    const c = numEdit("Gravity", () => 9.81, () => {}, "m/s²");
    const input = focusable(c.root)[0];
    expect(accessibleName(input)).toContain("Gravity");
    expect(accessibleName(input)).toContain("m/s²");
  });

  it("checkbox is named by the label that wraps it", () => {
    const c = checkbox("Show grid", () => true, () => {});
    expect(accessibleName(focusable(c.root)[0])).toContain("Show grid");
  });

  it("textEdit takes an explicit name, since a placeholder is not one", () => {
    const named = textEdit(() => "", () => true, "type here", "Object name");
    expect(accessibleName(focusable(named.root)[0])).toBe("Object name");
  });

  it("an icon-only button is named by its tooltip", () => {
    const c = button("", () => {}, { icon: "<svg></svg>", tooltip: "Zoom to fit" });
    expect(accessibleName(c.root)).toBe("Zoom to fit");
    expect(c.root.getAttribute("aria-label")).toBe("Zoom to fit");
  });

  it("colour presets expose the selected swatch", () => {
    let colour: [number, number, number] = [255, 0, 0];
    const c = colourEdit("Body colour", () => colour,
      (next) => { colour = next; }, { presets: [[255, 0, 0], [0, 0, 255]] });
    const swatches = [...c.root.querySelectorAll<HTMLButtonElement>("button.swatch")];
    expect(swatches.map((b) => b.getAttribute("aria-pressed")))
      .toEqual(["true", "false"]);
    swatches[1].click();
    expect(swatches.map((b) => b.getAttribute("aria-pressed")))
      .toEqual(["false", "true"]);
  });

  it("colourEdit names its swatch and its hex field", () => {
    const c = colourEdit("Colour", () => [1, 2, 3], () => {});
    for (const el of focusable(c.root)) {
      expect(accessibleName(el).length).toBeGreaterThan(0);
    }
  });
});

describe("a slider announces the quantity, not its track position", () => {
  it("reports the formatted value and unit, never the raw 0..2000", () => {
    let v = 12;
    const c = slider("Mass", () => v, (x) => { v = x; }, 0.001, 10000,
                     { unit: "kg", log: true });
    const range = c.root.querySelector("input[type=range]")!;
    const text = range.getAttribute("aria-valuetext");
    expect(text).toBe("12 kg");
    // the raw position is a different number entirely, which is the point
    expect((range as HTMLInputElement).value).not.toBe("12");
  });

  it("keeps the announced value in step with the real one", () => {
    let v = 1;
    const c = slider("Speed", () => v, (x) => { v = x; }, 0.01, 16,
                     { unit: "x", fmt: (x) => x.toFixed(2) });
    const range = c.root.querySelector("input[type=range]")!;
    expect(range.getAttribute("aria-valuetext")).toBe("1.00 x");
    v = 4;
    c.refresh!();
    expect(range.getAttribute("aria-valuetext")).toBe("4.00 x");
  });

  it("works without a unit too", () => {
    const c = slider("Iterations", () => 8, () => {}, 1, 64, { step: 1 });
    const range = c.root.querySelector("input[type=range]")!;
    expect(range.getAttribute("aria-valuetext")).toBe("8");
  });
});

describe("selected state is exposed, not only styled", () => {
  it("a toggle button reports pressed, and keeps it in step", () => {
    let on = false;
    const c = button("Auto-fit", () => {}, { isActive: () => on });
    expect(c.root.getAttribute("aria-pressed")).toBe("false");
    on = true;
    c.refresh!();
    expect(c.root.getAttribute("aria-pressed")).toBe("true");
    expect(c.root.classList.contains("active")).toBe(true);
  });

  it("a plain button is not mislabelled as a toggle", () => {
    const c = button("Reset", () => {});
    expect(c.root.hasAttribute("aria-pressed")).toBe(false);
  });

  it("a segmented strip is a group, with exactly one option pressed", () => {
    let cur = "Dark";
    const c = segmented(["Void", "Dark", "Light"], () => cur,
                        (v) => { cur = v; }, "Colour theme");
    expect(c.root.getAttribute("role")).toBe("group");
    expect(c.root.getAttribute("aria-label")).toBe("Colour theme");
    const pressed = () => [...c.root.querySelectorAll("button")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);
    expect(pressed()).toEqual(["Dark"]);
    cur = "Light";
    c.refresh!();
    expect(pressed()).toEqual(["Light"]);
  });

  it("a disabled strip still says which option is chosen", () => {
    const c = segmented(["A", "B"], () => "B", () => {}, "", () => true);
    c.refresh!();
    const b = [...c.root.querySelectorAll("button")];
    expect(b[1].getAttribute("aria-pressed")).toBe("true");
    expect(b.every((x) => x.disabled)).toBe(true);
  });
});

describe("tab navigation", () => {
  it("uses roving focus and activates with arrows, Home and End", () => {
    const list = document.createElement("div");
    const buttons = new Map<string, HTMLButtonElement>();
    for (const name of ["Selection", "World", "View"]) {
      const b = document.createElement("button");
      b.textContent = name;
      list.append(b);
      buttons.set(name, b);
    }
    document.body.append(list);
    let active = "Selection";
    const select = (next: string) => {
      active = next;
      refreshTabs(buttons, active);
    };
    wireTabs(list, buttons, select);
    select(active);
    expect(list.getAttribute("role")).toBe("tablist");
    expect([...buttons.values()].map((b) => [b.getAttribute("role"), b.tabIndex,
                                             b.getAttribute("aria-selected")]))
      .toEqual([["tab", 0, "true"], ["tab", -1, "false"],
                ["tab", -1, "false"]]);

    buttons.get("Selection")!.focus();
    buttons.get("Selection")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(active).toBe("View");
    expect(document.activeElement).toBe(buttons.get("View"));
    buttons.get("View")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(active).toBe("Selection");
    buttons.get("Selection")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(active).toBe("View");
    list.remove();
  });
});

describe("the announced state does not thrash the DOM", () => {
  it("re-refreshing an unchanged control rewrites nothing", () => {
    // these refresh every frame, so a blind setAttribute would be a write
    // per control per frame - and an aria change is an announcement
    let writes = 0;
    const c = button("Follow", () => {}, { isActive: () => true });
    const spy = c.root.setAttribute.bind(c.root);
    c.root.setAttribute = (n: string, v: string) => { writes++; spy(n, v); };
    c.refresh!();
    c.refresh!();
    c.refresh!();
    expect(writes).toBe(0);
  });

  it("a slider only rewrites its value text when the value moves", () => {
    let v = 2;
    const c = slider("Radius", () => v, () => {}, 0.01, 5, { unit: "m" });
    const range = c.root.querySelector("input[type=range]") as HTMLInputElement;
    let writes = 0;
    const spy = range.setAttribute.bind(range);
    range.setAttribute = (n: string, val: string) => { writes++; spy(n, val); };
    c.refresh!();
    c.refresh!();
    expect(writes).toBe(0);
    v = 3;
    c.refresh!();
    expect(writes).toBe(1);
  });
});
