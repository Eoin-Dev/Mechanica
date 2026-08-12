/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { Tour } from "../src/ui/tour";

function appStub(): App {
  return { playing: false, settings: {}, saveSettings() {} } as unknown as App;
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
});

describe("guided tour modality", () => {
  it("inerts the app, traps the dialog, and restores its opener", () => {
    const shell = document.createElement("div");
    shell.id = "app";
    const opener = document.createElement("button");
    opener.textContent = "Tour";
    shell.append(opener);
    document.body.append(shell);
    opener.focus();

    const tour = new Tour(appStub());
    tour.start();
    const card = document.querySelector<HTMLElement>(".tour-card")!;
    expect(shell.inert).toBe(true);
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.contains(document.activeElement)).toBe(true);

    tour.finish();
    expect(shell.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector(".tour-root")).toBeNull();
  });

  it("derives the visible step count from the active steps", () => {
    document.body.append(Object.assign(document.createElement("div"), { id: "app" }));
    const tour = new Tour(appStub());
    tour.start();
    const progress = document.querySelector(".tour-step")!.textContent!;
    const count = Number(/of (\d+)/.exec(progress)![1]);
    expect(document.querySelector(".tour-card p")!.textContent)
      .toContain(`${count} quick ${count === 1 ? "stop" : "stops"}`);
    tour.finish();
  });
});
