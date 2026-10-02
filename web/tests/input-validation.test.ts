/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { colourEdit, numEdit, slider, textEdit } from "../src/ui/dom";

beforeEach(() => document.body.replaceChildren());

function typeAndBlur(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = text;
  input.blur();
}

function escape(input: HTMLInputElement): void {
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("invalid input survives panel refresh", () => {
  it("keeps a rejected formula until it is corrected or cancelled", () => {
    let saved = "x";
    const control = textEdit(() => saved, value => {
      if (value === "x+") return false;
      saved = value;
      return true;
    });
    const input = control.root as HTMLInputElement;
    document.body.append(input);
    typeAndBlur(input, "x+");
    control.refresh!();
    expect(input.value).toBe("x+");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    typeAndBlur(input, "x+1");
    control.refresh!();
    expect(saved).toBe("x+1");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    typeAndBlur(input, "x+");
    escape(input);
    expect(input.value).toBe("x+1");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it.each(["2oops", "1e", "", "Infinity", "0x10"])("rejects the complete numeric entry %j", text => {
    const setter = vi.fn();
    const control = numEdit("Position", () => 3, setter);
    document.body.append(control.root);
    const input = control.root.querySelector("input")!;
    typeAndBlur(input, text);
    control.refresh!();
    expect(setter).not.toHaveBeenCalled();
    expect(input.value).toBe(text);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    escape(input);
    expect(input.value).toBe("3");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("accepts decimal scientific notation and commits once", () => {
    let value = 3;
    const committed = vi.fn();
    const control = numEdit("Force", () => value, v => { value = v; }, "N", committed);
    document.body.append(control.root);
    typeAndBlur(control.root.querySelector("input")!, " -2.5e2 ");
    expect(value).toBe(-250);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("retains a domain-rejected number without committing and allows correction", () => {
    let value = 3;
    const committed = vi.fn();
    const control = numEdit("Modulus", () => value, next => {
      if (next < 0) return false;
      value = next;
    }, "N", committed);
    document.body.append(control.root);
    const input = control.root.querySelector("input")!;
    typeAndBlur(input, "-4");
    control.refresh!();
    expect(value).toBe(3);
    expect(input.value).toBe("-4");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(committed).not.toHaveBeenCalled();
    typeAndBlur(input, "4");
    expect(value).toBe(4);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(committed).toHaveBeenCalledTimes(1);
    typeAndBlur(input, "-5");
    escape(input);
    expect(input.value).toBe("4");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("drops a numeric draft when the control becomes disabled and restores editing when enabled", () => {
    let disabled = false;
    const setter = vi.fn();
    const committed = vi.fn();
    const control = numEdit("Modulus", () => 3, setter, "N", committed, String,
      { disabled: () => disabled });
    document.body.append(control.root);
    const input = control.root.querySelector("input")!;
    input.focus();
    input.value = "8";
    disabled = true;
    control.refresh!();
    input.blur();
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("3");
    expect(setter).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    disabled = false;
    control.refresh!();
    typeAndBlur(input, "8");
    expect(setter).toHaveBeenCalledExactlyOnceWith(8);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("retains an invalid exact slider value and recovers through the track", () => {
    let value = 3;
    const control = slider("Mass", () => value, v => { value = v; }, 1, 10);
    document.body.append(control.root);
    const exact = control.root.querySelector<HTMLInputElement>(".val")!;
    const track = control.root.querySelector<HTMLInputElement>("[type=range]")!;
    typeAndBlur(exact, "4foo");
    control.refresh!();
    expect(value).toBe(3);
    expect(exact.value).toBe("4foo");
    track.value = "2000";
    track.dispatchEvent(new Event("input"));
    expect(value).toBe(10);
    expect(exact.value).toBe("10");
    expect(exact.hasAttribute("aria-invalid")).toBe(false);
  });

  it("keeps stepped exact values inside the declared slider range", () => {
    let value = 0.15;
    const control = slider("Radius", () => value, v => { value = v; }, 0.15, 0.95, { step: 0.1 });
    document.body.append(control.root);
    typeAndBlur(control.root.querySelector<HTMLInputElement>(".val")!, "0.95");
    expect(value).toBe(0.95);
  });

  it("names both colour inputs and preserves an invalid hex entry", () => {
    const setter = vi.fn();
    const control = colourEdit("Body", () => [1, 2, 3], setter, { presets: [[1, 2, 3]] });
    document.body.append(control.root);
    const hex = control.root.querySelector<HTMLInputElement>(".colour-hex")!;
    expect(hex.getAttribute("aria-label")).toBe("Body hex colour");
    expect(control.root.querySelector("[type=color]")!.getAttribute("aria-label")).toBe("Body colour");
    typeAndBlur(hex, "#oops");
    control.refresh!();
    expect(hex.value).toBe("#oops");
    expect(setter).not.toHaveBeenCalled();
    escape(hex);
    expect(hex.value).toBe("#010203");
    expect(hex.hasAttribute("aria-invalid")).toBe(false);
    const chip = control.root.querySelector(".swatch")!;
    const write = vi.spyOn(chip, "setAttribute");
    control.refresh!();
    control.refresh!();
    expect(write).not.toHaveBeenCalled();
  });
});
