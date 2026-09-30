/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mathEdit } from "../src/ui/mathedit";

const state = vi.hoisted(() => ({ failAttach: false }));

vi.mock("mathlive", () => {
  class MathfieldElement extends HTMLElement {
    static fontsDirectory: string | null = null;
    static soundsDirectory: string | null = null;
    value = "";
    inlineShortcuts = {};
    set menuItems(_value: unknown[]) {
      if (state.failAttach) throw new Error("Cannot configure field");
    }
    smartSuperscript = true;
    getValue(): string { return this.value; }
    setValue(value: string): void { this.value = value; }
  }
  customElements.define("math-field", MathfieldElement);
  return { MathfieldElement };
});
vi.mock("mathlive/fonts.css", () => ({}));

type Field = HTMLElement & { value: string; getValue(): string };
beforeEach(() => {
  document.body.replaceChildren();
  state.failAttach = false;
});

async function mounted(commit: (source: string) => boolean) {
  const control = mathEdit(() => "x", commit, "", "Force x");
  document.body.append(control.root);
  await vi.waitFor(() => expect(control.root.querySelector("math-field")).not.toBeNull());
  const field = control.root.querySelector<Field>("math-field")!;
  return { control, field };
}

describe("typeset formula edits", () => {
  it("restores the functional text input if mounted MathLive configuration fails", async () => {
    state.failAttach = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const commit = vi.fn(() => true);
    const control = mathEdit(() => "x", commit, "", "Force x");
    document.body.append(control.root);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    const input = control.root.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBe("Force x");
    input.focus();
    input.value = "y";
    input.blur();
    expect(commit).toHaveBeenCalledWith("y");
    control.refresh!();
    expect(input.value).toBe("x");
    warning.mockRestore();
  });

  it("waits for an invalid interim edit to be corrected before upgrading", async () => {
    const control = mathEdit(() => "x", value => value === "x", "", "Force x");
    document.body.append(control.root);
    const input = control.root.querySelector("input")!;
    input.focus();
    input.value = "unfinished";
    input.blur();
    await vi.dynamicImportSettled();
    expect(control.root.querySelector("math-field")).toBeNull();
    expect(input.value).toBe("unfinished");
    input.focus();
    input.value = "x";
    input.blur();
    await vi.waitFor(() => expect(control.root.querySelector("math-field")).not.toBeNull());
  });

  it("retains a convertible formula rejected by the force-field compiler", async () => {
    const commit = vi.fn(() => false);
    const { control, field } = await mounted(commit);
    field.value = "y";
    field.dispatchEvent(new Event("blur"));
    control.refresh!();
    expect(commit).toHaveBeenCalledWith("y");
    expect(field.value).toBe("y");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(control.root.querySelector<HTMLElement>(".error-text")!.hidden).toBe(false);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(field.value).toBe("x");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
  });

  it("keeps invalid LaTeX and allows a corrected retry", async () => {
    const commit = vi.fn(() => true);
    const { control, field } = await mounted(commit);
    field.value = "\\frac{}{}";
    field.dispatchEvent(new Event("blur"));
    control.refresh!();
    expect(field.value).toBe("\\frac{}{}");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(commit).not.toHaveBeenCalled();
    field.value = "y";
    field.dispatchEvent(new Event("blur"));
    expect(commit).toHaveBeenCalledWith("y");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
  });

  it("does not build a math field for a row removed during loading", async () => {
    const control = mathEdit(() => "x", () => true);
    document.body.append(control.root);
    control.root.remove();
    await vi.dynamicImportSettled();
    expect(control.root.querySelector("math-field")).toBeNull();
  });
});
