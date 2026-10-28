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
  it("keeps ordinary feedback neutral and uses error styling only when explicitly requested", () => {
    notices.show("Loaded 'Friction ramp'");
    expect(host.firstElementChild!.classList.contains("toast-error")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    notices.show("Could not save", { severity: "error" });
    expect(host.querySelector('.toast-error[role="alert"]')).not.toBeNull();
    notices.show("Could not save");
    expect(host.querySelectorAll(".toast-error")).toHaveLength(1);
    expect(host.children).toHaveLength(3);
  });
  it("uses the concise refresh design without a counter or restart action", () => {
    for (let i = 0; i < 2; i++) notices.show("", { title: "Page refreshed", refresh: true });
    expect(host.querySelectorAll(".toast-refresh")).toHaveLength(2);
    expect([...host.querySelectorAll(".toast-title")].map(node => node.textContent)).toEqual(["Page refreshed", "Page refreshed"]);
    expect(host.querySelector(".toast-action")).toBeNull(); expect(host.querySelector(".toast-message")).toBeNull();
    expect(host.textContent).not.toContain("Start fresh");
  });
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

  it("renews repeated plain feedback without stacking or losing a notice during its fade", () => {
    notices.show("Read me");
    const root = host.firstChild as HTMLElement;
    vi.advanceTimersByTime(3250);
    expect(root.style.opacity).toBe("0");
    notices.show("Read me");
    expect(host.children).toHaveLength(1);
    expect(host.firstChild).toBe(root);
    expect(root.style.opacity).toBe("");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    notices.show("Different feedback");
    expect(host.children).toHaveLength(2);
    vi.advanceTimersByTime(2519);
    expect(root.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root.isConnected).toBe(false);
    expect(host.textContent).toContain("Different feedback");
  });

  it("preserves focused repeated feedback and allows a new notice after dismissal", () => {
    const opener = document.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus(); notices.show("Keyboard feedback");
    const dismiss = host.querySelector("button")!;
    dismiss.focus(); notices.show("Keyboard feedback");
    expect(host.children).toHaveLength(1);
    expect(document.activeElement).toBe(dismiss);
    vi.advanceTimersByTime(20_000);
    expect(dismiss.isConnected).toBe(true);
    dismiss.click(); expect(document.activeElement).toBe(opener);
    notices.show("Keyboard feedback");
    expect(host.children).toHaveLength(1);
    expect(host.querySelector("button")).not.toBe(dismiss);
  });

  it("keeps separately actionable notices even when their text matches", () => {
    const first = vi.fn(), second = vi.fn();
    notices.show("Undo", { title: "First change", action: { label: "Restore", run: first } });
    notices.show("Undo", { title: "Second change", action: { label: "Restore", run: second } });
    const actions = host.querySelectorAll<HTMLButtonElement>(".toast-action");
    expect(actions).toHaveLength(2);
    actions[1].click(); expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
    actions[0].click(); expect(first).toHaveBeenCalledOnce();
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
