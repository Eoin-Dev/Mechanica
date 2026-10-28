/** Retained-canvas invalidation for the forces actually visible in a diagram. */
import type { Body } from "../engine/body";
import type { ForceSnapshot } from "../engine/force-diagnostics";
import type { World } from "../engine/world";
import { analysisNumber } from "./analysis-overlays";

export class ForcePresentation {
  private painted = new Map<Body, ForceSnapshot | null>();

  changed(world: World, pixelsPerNewton: number, performanceMode: boolean): boolean {
    if (performanceMode) return false;
    let count = 0;
    for (const body of world.bodies) {
      if (!body.showForceComponents || body.isAnchor || body.isRodEndpoint) continue;
      count++;
      if (!this.painted.has(body)) return true;
      const previous = this.painted.get(body), next = body.forceSnapshot;
      if (previous === next) continue;
      if (!previous || !next || previous.entries.length !== next.entries.length) return true;
      for (let i = 0; i < next.entries.length; i++) {
        const a = previous.entries[i], b = next.entries[i];
        if (a.id !== b.id || a.kind !== b.kind || a.label !== b.label ||
            a.contactNx !== b.contactNx || a.contactNy !== b.contactNy) return true;
        if (a.fx === b.fx && a.fy === b.fy) continue;
        // Compare against the last painted sample, so tiny increments accumulate.
        // Subpixel movement alone does not wake an otherwise settled canvas.
        if (Math.hypot(a.fx - b.fx, a.fy - b.fy) * Math.abs(pixelsPerNewton) >= 0.05 ||
            analysisNumber(Math.hypot(a.fx, a.fy)) !== analysisNumber(Math.hypot(b.fx, b.fy))) return true;
      }
    }
    return count !== this.painted.size;
  }

  mark(world: World, performanceMode: boolean): void {
    this.painted.clear();
    if (performanceMode) return;
    for (const body of world.bodies) {
      if (body.showForceComponents && !body.isAnchor && !body.isRodEndpoint)
        this.painted.set(body, body.forceSnapshot);
    }
  }
}
