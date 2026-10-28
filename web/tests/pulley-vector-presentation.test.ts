/** Wheel/resultant and string/leg overlay choices survive scene/history boundaries. */
import { describe, expect, it } from "vitest";
import { analysePulley } from "../src/education/analysis";
import { PulleyLink } from "../src/engine/links";
import { PRESETS } from "../src/scene/presets";
import { restore, restoreSnapshot, snapshot, structuralDigest } from "../src/scene/snapshot";

const assembly = () => {
  const world = PRESETS.find(preset => preset.name === "Atwood machine")!.build();
  const link = world.links[0] as PulleyLink;
  link.a.showForceComponents = link.b.showForceComponents = false;
  link.showTensionVectors = link.showResultantTensionVector = false;
  return { world, link };
};

describe("independent pulley vector presentation", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]] as const)(
    "round-trips independent choices through saved and internal scenes (legs=%s, wheel=%s)", (legs, wheel) => {
      const { world, link } = assembly();
      link.showTensionVectors = legs; link.showResultantTensionVector = wheel;
      const state = snapshot(world);
      for (const read of [restore, restoreSnapshot]) {
        const copied = read(state).links[0] as PulleyLink;
        expect(copied.showTensionVectors).toBe(legs);
        expect(copied.showResultantTensionVector).toBe(wheel);
      }
    });

  it("accepts legacy scenes and rejects non-boolean overlay metadata", () => {
    const { world } = assembly(), data = world.toDict();
    const old = restore(JSON.stringify(data)).links[0] as PulleyLink;
    expect(old.showTensionVectors || old.showResultantTensionVector).toBe(false);
    Object.assign(data.links[0], { show_tension_vectors: "true", show_resultant_tension_vector: 1 });
    const guarded = restore(JSON.stringify(data)).links[0] as PulleyLink;
    expect(guarded.showTensionVectors || guarded.showResultantTensionVector).toBe(false);
  });

  it("treats either serialized choice as a rewind structural boundary", () => {
    const { world, link } = assembly(), initial = structuralDigest(world);
    link.showTensionVectors = true; const legs = structuralDigest(world);
    expect(legs).not.toBe(initial);
    link.showResultantTensionVector = true; expect(structuralDigest(world)).not.toBe(legs);
  });

  it.each([false, 0, 1, 2, 3] as const)("records completed tension for the wheel alone (Performance=%s)", level => {
    const { world, link } = assembly();
    world.performance = level !== false;
    if (level !== false) world.performanceLevel = level;
    link.showResultantTensionVector = true;
    const now = analysePulley(link, world);
    expect(now.forceMode).toBe("current"); expect(now.tension).toBeCloseTo(23.52, 8);
    world.step(1 / 120);
    expect(link.a.forceSnapshot).not.toBeNull(); expect(link.b.forceSnapshot).not.toBeNull();
    const measured = analysePulley(link, world);
    expect(measured.forceMode).toBe("step-average"); expect(measured.forceInterval?.end).toBe(world.time);
    expect(measured.tension).toBeCloseTo(23.52, 6);
    expect(-(measured.forceAY + measured.forceBY)).toBeCloseTo(-47.04, 6);
  });
});
