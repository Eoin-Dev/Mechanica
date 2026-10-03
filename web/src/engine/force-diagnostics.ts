/** Optional, headless force accounting over one completed World.step. */
import type { Body, Wall } from "./body";

export type ForceKind =
  "weight" | "applied" | "drag" | "gravity" | "driver" | "field" |
  "spring" | "string" | "rod" | "pulley" | "reaction" | "friction" | "correction";

export interface ForceEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: ForceKind;
  readonly fx: number;
  readonly fy: number;
  /** Shared scalar pulley tension, averaged over the same interval as fx/fy.
   * Averaging a changing direction can shorten the vector without reducing
   * the mean scalar tension. */
  readonly axialForce?: number;
  /** Unit direction from the particle centre to its last sampled contact.
   * Ordinary smooth/link forces have no surface-contact origin. */
  readonly contactNx?: number;
  readonly contactNy?: number;
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

/** Use the same unambiguous arrow symbols in canvas captions and source rows. */
export function forceSymbols(entries: readonly ForceEntry[]): Map<string, string> {
  const base = (entry: ForceEntry): string => {
    switch (entry.kind) {
      case "weight": case "gravity": return "W";
      case "reaction": return "R";
      case "friction": return "F";
      case "correction": return "C";
      case "string": case "pulley": return "T";
      case "rod": case "spring": return entry.label.includes("thrust") ? "P" : "T";
      default: return "f";
    }
  };
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const symbol = base(entry);
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  const symbols = new Map<string, string>();
  for (const entry of entries) {
    const symbol = base(entry);
    const index = (used.get(symbol) ?? 0) + 1;
    used.set(symbol, index);
    const suffix = counts.get(symbol)! > 1 ?
      String(index).replace(/\d/g, digit => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)]) : "";
    symbols.set(entry.id, symbol + suffix);
  }
  return symbols;
}

interface Impulse {
  id: string;
  label: string;
  kind: ForceKind;
  x: number;
  y: number;
  axial: number;
  contactNx?: number;
  contactNy?: number;
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
 * allocated only for enabled diagrams and explicitly requested link endpoints. */
export class ForceRecorder {
  private records = new Map<Body, Record>();
  private startTime = 0;
  private wallNames = new Map<number, string>();
  get active(): boolean { return this.records.size !== 0; }

  clear(bodies: readonly Body[]): void {
    for (const { body } of this.records.values()) body.forceSnapshot = null;
    this.records.clear();
    this.wallNames.clear();
    for (const body of bodies) body.forceSnapshot = null;
  }

  begin(bodies: readonly Body[], time: number, walls: readonly Wall[] = [],
        additionalBodies?: ReadonlySet<Body>, includeDiagrams = true): void {
    for (const { body } of this.records.values()) body.forceSnapshot = null;
    this.records.clear();
    this.wallNames.clear();
    this.startTime = time;
    for (const body of bodies) {
      body.forceSnapshot = null;
      if ((!(includeDiagrams && body.showForceComponents) && !additionalBodies?.has(body)) || body.isRodEndpoint || body.isAnchor ||
          body.invMass === 0 || !Number.isFinite(body.mass)) continue;
      this.records.set(body, {
        body, entries: new Map(), x: 0, y: 0, ax: 0, ay: 0,
        namedX: 0, namedY: 0, vx: body.vel.x, vy: body.vel.y,
      });
    }
    if (this.active) for (const wall of walls) this.wallNames.set(wall.id, wall.name);
  }

  add(body: Body, id: string, label: string, kind: ForceKind,
      fx: number, fy: number, weight: number, axial = 0,
      contactNx?: number, contactNy?: number): void {
    const record = this.records.get(body);
    if (record === undefined || weight === 0 ||
        !Number.isFinite(fx) || !Number.isFinite(fy)) return;
    const x = fx * weight;
    const y = fy * weight;
    if (x === 0 && y === 0 && axial * weight === 0) return;
    let entry = record.entries.get(id);
    if (entry === undefined) {
      entry = { id, label, kind, x: 0, y: 0, axial: 0 };
      record.entries.set(id, entry);
    }
    entry.x += x;
    entry.y += y;
    entry.axial += axial * weight;
    if (contactNx !== undefined && contactNy !== undefined) {
      entry.contactNx = contactNx; entry.contactNy = contactNy;
    }
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
      record.namedX = record.x;
      record.namedY = record.y;
    }
  }

  velocityChange(id: string, label: string, kind: ForceKind): void {
    for (const record of this.records.values()) {
      const body = record.body;
      this.add(body, id, label, kind,
        (body.vel.x - record.vx) * body.mass - (record.x - record.namedX),
        (body.vel.y - record.vy) * body.mass - (record.y - record.namedY), 1);
    }
  }

  /** Keep opposing contacts separate; an aggregate can hide both arrows. */
  readonly contactImpulse = (
    a: Body, b: Body | null, wallId: number | null,
    nx: number, ny: number, normal: number, tangent: number,
    invMa: number, invMb: number,
  ): void => {
    this.recordContactBody(a, b, wallId, -invMa, nx, ny, normal, tangent, 1);
    if (b !== null) this.recordContactBody(b, a, null, invMb, nx, ny, normal, tangent, -1);
  };

  private recordContactBody(body: Body, source: Body | null, wallId: number | null,
                            signedInvMass: number, nx: number, ny: number,
                            normal: number, tangent: number, side: number): void {
    const record = this.records.get(body);
    if (record === undefined) return;
    const id = source === null ? `wall-${wallId}` : `body-${source.id}`;
    const name = source?.name ?? this.wallNames.get(wallId!) ?? `Wall ${wallId}`;
    const scale = body.mass * signedInvMass;
    this.add(body, `reaction-${id}`, `Reaction from ${name}`, "reaction",
      normal * nx * scale, normal * ny * scale, 1);
    this.add(body, `friction-${id}`, `Friction from ${name}`, "friction",
      -tangent * ny * scale, tangent * nx * scale, 1);
    for (const key of [`reaction-${id}`, `friction-${id}`]) {
      const entry = record.entries.get(key);
      if (entry !== undefined) {
        entry.contactNx = side * nx;
        entry.contactNy = side * ny;
      }
    }
  }

  finish(dt: number, endTime: number, stepCount: number, current = false): void {
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
        const axialForce = entry.axial / dt;
        if (!Number.isFinite(fx) || !Number.isFinite(fy) ||
            (Math.abs(fx) + Math.abs(fy) <= threshold &&
              (entry.kind !== "pulley" || Math.abs(axialForce) <= threshold))) return;
        const label = entry.id.startsWith("distance-") && entry.kind === "rod" ?
          (entry.axial >= 0 ? "Rod tension" : "Rod thrust") :
          entry.id.startsWith("spring-") && entry.kind === "spring" ?
            (entry.axial >= 0 ? "Spring tension" : "Spring thrust") : entry.label;
        entries.push(Object.freeze({ id: entry.id, label, kind: entry.kind, fx, fy,
          ...(entry.kind === "pulley" ? { axialForce: Math.max(0, axialForce) } : {}),
          ...(entry.contactNx === undefined ? {} :
            { contactNx: entry.contactNx, contactNy: entry.contactNy }) }));
      };
      for (const entry of record.entries.values()) append(entry);
      let namedX = 0;
      let namedY = 0;
      for (const entry of entries) { namedX += entry.fx; namedY += entry.fy; }
      // Any remaining integration roundoff or guard effect is a numerical
      // correction, never evidence of an unobserved physical contact.
      if (!current) append({ id: "numerical-correction", label: "Numerical correction",
        kind: "correction", x: (body.netForce.x - namedX) * dt,
        y: (body.netForce.y - namedY) * dt, axial: 0 }, tolerance);
      body.forceSnapshot = Object.freeze({
        entries: Object.freeze(entries), startTime: this.startTime, endTime,
        stepCount, x: body.pos.x, y: body.pos.y, vx: body.vel.x, vy: body.vel.y,
        mass: body.mass, fx: current ? namedX : body.netForce.x,
        fy: current ? namedY : body.netForce.y,
      });
    }
    // Never retain references to deleted bodies between steps.
    this.records.clear();
    this.wallNames.clear();
  }
}
