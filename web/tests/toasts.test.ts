/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toasts } from "../src/ui/toasts";

let host: HTMLElement;
let notices: Toasts;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="opener">Edit</button><div id="toasts"></div>';
  host = document.querySelector("#toasts")!;
  notices = new Toasts(host);
});
afterEach(() => { vi.useRealTimers(); });

describe("notifications", () => {
  it("treats user content as text and offers an explicitly named dismissal", () => {
    notices.show('<script>alert("name")</script>');
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector(".toast-message")!.textContent).toContain("<script>");
    const dismiss = host.querySelector("button")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss notification");
    dismiss.click();
    expect(host.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps only the three newest messages and cancels evicted timers", () => {
    for (const message of ["one", "two", "three", "four"]) notices.show(message);
    expect([...host.querySelectorAll(".toast-message")].map(node => node.textContent))
      .toEqual(["two", "three", "four"]);
    expect(vi.getTimerCount()).toBe(3);
    vi.runAllTimers();
    expect(host.children).toHaveLength(0);
  });

  it("gives long feedback more reading time before fading", () => {
    notices.show("Short notice");
    notices.show("A".repeat(200));
    vi.advanceTimersByTime(3600);
    expect(host.children).toHaveLength(1);
    vi.advanceTimersByTime(5800);
    expect((host.firstChild as HTMLElement).style.opacity).toBe("0");
    vi.advanceTimersByTime(320);
    expect(host.children).toHaveLength(0);
  });

  it("pauses expiry while hovered, including during a fade", () => {
    notices.show("Read me");
    const root = host.firstChild as HTMLElement;
    vi.advanceTimersByTime(3250);
    expect(root.style.opacity).toBe("0");
    root.dispatchEvent(new Event("pointerenter"));
    expect(root.style.opacity).toBe("");
    vi.advanceTimersByTime(20_000);
    expect(root.isConnected).toBe(true);
    root.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(3520);
    expect(root.isConnected).toBe(false);
  });

  it("keeps focused notices available and restores the opener on dismissal", () => {
    const opener = document.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    notices.show("Keyboard feedback");
    const dismiss = host.querySelector("button")!;
    dismiss.focus();
    vi.advanceTimersByTime(20_000);
    expect(dismiss.isConnected).toBe(true);
    dismiss.click();
    expect(document.activeElement).toBe(opener);
  });

  it("resumes expiry after keyboard focus leaves", async () => {
    notices.show("Keyboard feedback");
    host.querySelector("button")!.focus();
    document.querySelector<HTMLButtonElement>("#opener")!.focus();
    await Promise.resolve();
    vi.advanceTimersByTime(3520);
    expect(host.children).toHaveLength(0);
  });
});
