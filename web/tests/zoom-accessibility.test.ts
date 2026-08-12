import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import main from "../src/main.ts?raw";
import tools from "../src/interact/tools.ts?raw";
import panels from "../src/ui/panels.ts?raw";
import css from "../src/style.css?raw";

describe("zoom stays inside the simulation and graph", () => {
  it("restricts the viewport and suppresses browser zoom inputs globally", () => {
    expect(html).toMatch(/maximum-scale\s*=\s*1/i);
    expect(html).toMatch(/user-scalable\s*=\s*no/i);
    expect(main).toMatch(/gesturestart/);
    expect(main).toMatch(/gesturechange/);
    expect(main).toMatch(/document\.addEventListener\("wheel"[\s\S]*?preventDefault/);
    expect(main).toMatch(/\["\+", "=", "-", "_", "0"\][\s\S]*?preventDefault/);
  });

  it("keeps modified wheels out of both canvas zoom handlers", () => {
    for (const source of [tools, panels]) {
      expect(source).toMatch(/if \(e\.ctrlKey \|\| e\.metaKey\) return/);
    }
  });

  it("scopes custom touch gestures to direct-manipulation surfaces", () => {
    const body = /body\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/touch-action:\s*auto/);
    expect(css).toMatch(/#canvas[^{}]*\{[^}]*touch-action:\s*none/);
  });

  it("uses the original stronger accent colour for heading treatments", () => {
    for (const selector of [".section", ".guide-h", ".tour-step", ".help-heading"]) {
      const escaped = selector.replace(".", "\\.");
      expect(css).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*color:\\s*var\\(--accent\\)`));
    }
    expect(css).toMatch(/\.preset-card \.cat\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(css).toMatch(/\.help-cols h3\s*\{[^}]*color:\s*var\(--accent\)/);
  });
});
