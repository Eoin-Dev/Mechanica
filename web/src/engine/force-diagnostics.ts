/** Optional, headless force accounting over one completed World.step. */
import type { Body } from "./body";

export type ForceKind =
  "weight" | "applied" | "drag" | "gravity" | "driver" | "field" |
  "spring" | "string" | "rod" | "pulley" | "reaction" | "correction";

export interface ForceEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: ForceKind;
  readonly fx: number;
  readonly fy: number;
}

export interface ForceSnapshot {
  readonly entries: readonly ForceEntry[];
  readonly startTime: number;
  readonly endTime: number;
  readonly stepCount: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly mass: number;
  readonly fx: number;
  readonly fy: number;
}

interface Impulse {
  id: string;
  label: string;
  kind: ForceKind;
  x: number;
  y: number;
  axial: number;
}

interface Record {
  body: Body;
  entries: Map<string, Impulse>;
  x: number;
  y: number;
  ax: number;
  ay: number;
  namedX: number;
  namedY: number;
  vx: number;
  vy: number;
}

/** Accumulate quadrature-weighted smooth forces and measured solver impulses.
 * No formula is evaluated here and no physical state is changed. Records are
 * allocated only for particles with their free-body diagram enabled. */
export class ForceRecorder {
  private records = new Map<Body, Record>();
  private startTime = 0;
  get active(): boolean { return this.records.size !== 0; }

  clear(bodies: readonly Body[]): void {
    for (const { body } of this.records.values()) body.forceSnapshot = null;
    this.records.clear();
    for (const body of bodies) body.forceSnapshot = null;
  }

  begin(bodies: readonly Body[], time: number): void {
    for (const { body } of this.records.values()) body.forceSnapshot = null;
    this.records.clear();
    this.startTime = time;
    for (const body of bodies) {
      body.forceSnapshot = null;
      if (!body.showForceComponents || body.isRodEndpoint || body.isAnchor ||
          body.invMass === 0 || !Number.isFinite(body.mass)) continue;
      this.records.set(body, {
        body, entries: new Map(), x: 0, y: 0, ax: 0, ay: 0,
        namedX: 0, namedY: 0, vx: body.vel.x, vy: body.vel.y,
      });
    }
  }

  add(body: Body, id: string, label: string, kind: ForceKind,
      fx: number, fy: number, weight: number, axial = 0): void {
    const record = this.records.get(body);
    if (record === undefined || weight === 0 ||
        !Number.isFinite(fx) || !Number.isFinite(fy)) return;
    const x = fx * weight;
    const y = fy * weight;
    if (x === 0 && y === 0) return;
    let entry = record.entries.get(id);
    if (entry === undefined) {
      entry = { id, label, kind, x: 0, y: 0, axial: 0 };
      record.entries.set(id, entry);
    }
    entry.x += x;
    entry.y += y;
    entry.axial += axial * weight;
    record.x += x;
    record.y += y;
  }

  captureAcceleration(): void {
    for (const record of this.records.values()) {
      record.ax = record.body.acc.x;
      record.ay = record.body.acc.y;
      record.namedX = record.x;
      record.namedY = record.y;
    }
  }

  /** Record the actual acceleration change, less any individually named rows
   * recorded since captureAcceleration (e.g. rod tension before attachments). */
  accelerationChange(id: string, label: string, kind: ForceKind, weight: number): void {
    for (const record of this.records.values()) {
      const body = record.body;
      const x = (body.acc.x - record.ax) * body.mass * weight -
        (record.x - record.namedX);
      const y = (body.acc.y - record.ay) * body.mass * weight -
        (record.y - record.namedY);
      this.add(body, id, label, kind, x, y, 1);
    }
  }

  captureVelocity(): void {
    for (const record of this.records.values()) {
      record.vx = record.body.vel.x;
      record.vy = record.body.vel.y;
    }
  }

  velocityChange(id: string, label: string, kind: ForceKind): void {
    for (const record of this.records.values()) {
      const body = record.body;
      this.add(body, id, label, kind,
        (body.vel.x - record.vx) * body.mass,
        (body.vel.y - record.vy) * body.mass, 1);
    }
  }

  finish(dt: number, endTime: number, stepCount: number): void {
    for (const record of this.records.values()) {
      const body = record.body;
      // Sleeping/locked bodies have no realised delta-v diagnostic. Their
      // resting support is displayed separately by the analytical preview.
      if (body.invMass === 0) continue;
      const entries: ForceEntry[] = [];
      let scale = 0;
      for (const entry of record.entries.values()) {
        scale += (Math.abs(entry.x) + Math.abs(entry.y)) / dt;
      }
      const tolerance = Math.max(1e-10, 128 * Number.EPSILON * scale);
      const append = (entry: Impulse, threshold = 1e-10): void => {
        const fx = entry.x / dt;
        const fy = entry.y / dt;
        if (!Number.isFinite(fx) || !Number.isFinite(fy) ||
            Math.abs(fx) + Math.abs(fy) <= threshold) return;
        const label = entry.id.startsWith("distance-") && entry.kind === "rod" ?
          (entry.axial >= 0 ? "Rod tension" : "Rod thrust") :
          entry.id.startsWith("spring-") && entry.kind === "spring" ?
            (entry.axial >= 0 ? "Spring tension" : "Spring thrust") : entry.label;
        entries.push(Object.freeze({ id: entry.id, label, kind: entry.kind, fx, fy }));
      };
      for (const entry of record.entries.values()) append(entry);
      let namedX = 0;
      let namedY = 0;
      for (const entry of entries) { namedX += entry.fx; namedY += entry.fy; }
      // Any remaining integration roundoff or guard effect is a numerical
      // correction, never evidence of an unobserved physical contact.
      append({ id: "numerical-correction", label: "Numerical correction",
        kind: "correction", x: (body.netForce.x - namedX) * dt,
        y: (body.netForce.y - namedY) * dt, axial: 0 }, tolerance);
      body.forceSnapshot = Object.freeze({
        entries: Object.freeze(entries), startTime: this.startTime, endTime,
        stepCount, x: body.pos.x, y: body.pos.y, vx: body.vel.x, vy: body.vel.y,
        mass: body.mass, fx: body.netForce.x, fy: body.netForce.y,
      });
    }
    // Never retain references to deleted bodies between steps.
    this.records.clear();
  }
}
