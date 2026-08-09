import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import main from "../src/main.ts?raw";
import tools from "../src/interact/tools.ts?raw";
import panels from "../src/ui/panels.ts?raw";
import css from "../src/style.css?raw";

describe("browser zoom remains available", () => {
  it("does not restrict the viewport or suppress browser zoom globally", () => {
    expect(html).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
    expect(main).not.toMatch(/gesturestart|gesturechange/);
    expect(main).not.toMatch(/ctrlKey[^\n]+preventDefault|metaKey[^\n]+preventDefault/);
  });

  it("leaves modified canvas and graph wheels to the browser", () => {
    for (const source of [tools, panels]) {
      expect(source).toMatch(/if \(e\.ctrlKey \|\| e\.metaKey\) return/);
    }
  });

  it("scopes custom touch gestures to direct-manipulation surfaces", () => {
    const body = /body\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/touch-action:\s*auto/);
    expect(css).toMatch(/#canvas[^{}]*\{[^}]*touch-action:\s*none/);
  });
});
