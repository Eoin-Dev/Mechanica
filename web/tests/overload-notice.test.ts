// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OverloadNotice } from "../src/ui/overload";

describe("overload advice", () => {
  it("updates advice when Performance mode changes without changing the bottleneck", () => {
    const app = { slowReason: () => "render" as const, perfMode: false };
    const root = document.createElement("div");
    root.hidden = true;
    const notice = new OverloadNotice(app, root);
    notice.refresh();
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("enable Performance mode");
    app.perfMode = true;
    notice.refresh();
    expect(root.textContent).toContain("maximum Performance speed");
    expect(root.textContent).not.toMatch(/enable Performance|trails/);
  });

  it("clears the warning after overload ends and avoids unchanged live-region writes", () => {
    let reason: "physics" | "render" | null = "physics";
    const root = document.createElement("div");
    const app = { slowReason: () => reason, perfMode: false };
    const notice = new OverloadNotice(app, root);
    const writes = vi.spyOn(root, "textContent", "set");
    notice.refresh();
    expect(root.textContent).toContain("substeps, iterations or body count");
    notice.refresh();
    expect(writes).toHaveBeenCalledTimes(1);
    reason = null;
    notice.refresh();
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
    notice.refresh();
    expect(writes).toHaveBeenCalledTimes(2);
    app.perfMode = true;
    reason = "physics";
    notice.refresh();
    expect(root.textContent).toContain("Try fewer bodies");
    expect(root.textContent).not.toMatch(/substeps|iterations/);
  });
});
