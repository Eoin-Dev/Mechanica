import { describe, expect, it, vi } from "vitest";
import { Body } from "../src/engine/body";
import { Camera } from "../src/render/camera";
import { prepareParticleHover } from "../src/render/particle-hover";

function context() {
  return { font: "prior font", measureText: vi.fn((text: string) => ({ width: Array.from(text).length * 7 })) } as unknown as CanvasRenderingContext2D;
}
function particleAt(camera: Camera, x: number, y: number, name = "Mass α") {
  const body = new Body(camera.toWorld(x, y), 0.15);
  body.name = name;
  return body;
}

describe("subtle hovered-particle name bounds", () => {
  it("keeps long Unicode names within every viewport edge at all text sizes", () => {
    for (const [width, height] of [[64, 64], [260, 200], [1200, 900]]) {
      const camera = new Camera(width, height); camera.zoom = 100;
      for (const scale of [0.8, 1, 1.2, 2]) for (const [x, y] of [
        [0, 0], [width, 0], [0, height], [width, height], [width / 2, height / 2],
      ]) {
        const ctx = context(), body = particleAt(camera, x, y, "📐α".repeat(40));
        const before = JSON.stringify(body.toDict());
        const cue = prepareParticleHover(ctx, camera, body, width, height, scale, [x, y])!;
        expect(cue).not.toBeNull();
        expect(cue.x).toBeGreaterThanOrEqual(6); expect(cue.y).toBeGreaterThanOrEqual(6);
        expect(cue.x + cue.width).toBeLessThanOrEqual(width - 6);
        expect(cue.y + cue.height).toBeLessThanOrEqual(height - 6);
        expect(cue.text).toMatch(/^(?:📐α)*(?:📐)?…$/u);
        expect(ctx.measureText(cue.text).width + 12 * scale).toBeLessThanOrEqual(cue.width);
        expect(ctx.font).toBe("prior font"); expect(JSON.stringify(body.toDict())).toBe(before);
      }
    }
  });

  it("anchors above the particle when room exists and below it at the top edge", () => {
    const camera = new Camera(800, 600); camera.zoom = 100;
    const body = particleAt(camera, 300, 200), ctx = context();
    const above = prepareParticleHover(ctx, camera, body, 800, 600, 1, [300, 200])!;
    expect(above.x + above.width / 2).toBe(300);
    expect(above.y + above.height).toBeLessThan(200 - 15);
    const top = camera.toWorld(300, 0); body.pos.set(top.x, top.y);
    const below = prepareParticleHover(ctx, camera, body, 800, 600, 1, [300, 0])!;
    expect(below.y).toBeGreaterThan(15);
  });

  it("does no text work for held/non-particle/inert/off-canvas/stale hover targets", () => {
    const camera = new Camera(800, 600); camera.zoom = 100;
    const body = particleAt(camera, 300, 200), ctx = context();
    for (const key of ["held", "isAnchor", "isRodEndpoint"] as const) {
      body[key] = true;
      expect(prepareParticleHover(ctx, camera, body, 800, 600, 1, [300, 200])).toBeNull();
      body[key] = false;
    }
    for (const pointer of [[700, 200], [-1, 200], [300, 601], [NaN, 0]] as const)
      expect(prepareParticleHover(ctx, camera, body, 800, 600, 1, pointer)).toBeNull();
    (ctx as unknown as { canvas: unknown }).canvas = { closest: () => ({}) };
    expect(prepareParticleHover(ctx, camera, body, 800, 600, 1, [300, 200])).toBeNull();
    expect(ctx.measureText).not.toHaveBeenCalled();
  });
});
