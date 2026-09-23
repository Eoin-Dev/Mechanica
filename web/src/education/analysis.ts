/** Headless educational diagnostics for the live dynamics world.
 *
 * The renderer and DOM consume these records, but the calculations remain
 * browser-independent so force ledgers, slope components, pulley analysis and
 * event detection can be verified directly.
 */
import { Body, Wall } from "../engine/body";
import { closestOnSegment, Contact } from "../engine/contacts";
import { DistanceLink, PulleyLink, SpringLink } from "../engine/links";
import { World } from "../engine/world";

export type ForceKind =
  "weight" | "applied" | "drag" | "gravity" | "driver" | "field" |
  "spring" | "string" | "rod" | "pulley" | "reaction";

export interface ForceEntry {
  id: string;
  label: string;
  kind: ForceKind;
  fx: number;
  fy: number;
}

export interface SlopeBasis {
  wallId: number;
  angle: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
}

export interface ForceLedger {
  entries: ForceEntry[];
  resultant: { fx: number; fy: number };
  basis: SlopeBasis | null;
}

function finiteForce(fx: number, fy: number): boolean {
  return Number.isFinite(fx) && Number.isFinite(fy) &&
    Math.abs(fx) + Math.abs(fy) > 1e-10;
}

function add(entries: ForceEntry[], id: string, label: string, kind: ForceKind,
             fx: number, fy: number): void {
  if (finiteForce(fx, fy)) entries.push({ id, label, kind, fx, fy });
}

/** Unit directions along a wall and away from its centreline toward a body. */
export function slopeBasis(wall: Wall, body?: Body): SlopeBasis | null {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return null;
  let tx = dx / length;
  let ty = dy / length;
  // Give the tangent a stable exam-style positive direction: rightward, or
  // upward for a vertical rod/plane.
  if (tx < -1e-12 || (Math.abs(tx) <= 1e-12 && ty < 0)) {
    tx = -tx;
    ty = -ty;
  }
  let nx = -ty;
  let ny = tx;
  if (body !== undefined) {
    const [cx, cy] = closestOnSegment(
      body.pos.x, body.pos.y, wall.a.x, wall.a.y, wall.b.x, wall.b.y);
    if ((body.pos.x - cx) * nx + (body.pos.y - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
  }
  return { wallId: wall.id, angle: Math.atan2(ty, tx), tx, ty, nx, ny };
}

export function projectForce(entry: Pick<ForceEntry, "fx" | "fy">,
                             basis: SlopeBasis): { parallel: number; normal: number } {
  return {
    parallel: entry.fx * basis.tx + entry.fy * basis.ty,
    normal: entry.fx * basis.nx + entry.fy * basis.ny,
  };
}

/** Named forces acting on one body at the latest completed solver step.
 *
 * Smooth authored forces and analytical link reactions are listed directly.
 * The realised m*delta-v/dt resultant is authoritative; any remainder is a
 * combined contact/constraint reaction, which includes normal/friction
 * impulses and the small position-level constraint correction. This residual
 * makes the vector sum exact without pretending an impulse is an
 * instantaneous smooth force.
 */
export function forceLedger(world: World, body: Body,
                            referenceWall: Wall | null = null): ForceLedger {
  const entries: ForceEntry[] = [];
  if (!body.locked && Number.isFinite(body.mass) && body.mass > 0) {
    add(entries, "weight", "Weight", "weight", 0, -body.mass * world.gravity);
    add(entries, "applied", "Applied force", "applied",
      body.constForce.x, body.constForce.y);
    const speed = body.vel.length();
    const drag = world.dragLinear + world.dragQuadratic * speed;
    add(entries, "drag", "Air resistance", "drag",
      -drag * body.vel.x, -drag * body.vel.y);
  }

  if (world.mutualGravity && world.G !== 0 && !body.isAnchor) {
    let fx = 0;
    let fy = 0;
    const eps2 = world.softening * world.softening;
    for (const other of world.bodies) {
      if (other === body || other.isAnchor) continue;
      const dx = other.pos.x - body.pos.x;
      const dy = other.pos.y - body.pos.y;
      const r2 = dx * dx + dy * dy;
      const radius = body.radius + other.radius;
      let scale: number;
      if (!world.pointGravity && r2 < radius * radius) {
        const d2 = radius * radius + eps2;
        scale = world.G * body.mass * other.mass /
          (d2 * Math.sqrt(d2));
      } else {
        const d2 = r2 + eps2;
        scale = world.G * body.mass * other.mass /
          (d2 * Math.sqrt(d2));
      }
      fx += scale * dx;
      fy += scale * dy;
    }
    add(entries, "mutual-gravity", "Mutual gravity", "gravity", fx, fy);
  }

  for (let i = 0; i < world.drivers.length; i++) {
    const driver = world.drivers[i];
    if (!driver.enabled || driver.bodyId !== body.id || body.invMass === 0) continue;
    const magnitude = driver.amplitude * Math.sin(
      2 * Math.PI * driver.frequency * world.time + driver.phase);
    add(entries, `driver-${i}`, "Driving force", "driver",
      magnitude * Math.cos(driver.angle), magnitude * Math.sin(driver.angle));
  }

  const env = {
    x: body.pos.x, y: body.pos.y, vx: body.vel.x, vy: body.vel.y,
    t: world.time, m: body.mass, r: body.pos.length(),
  };
  for (let i = 0; i < world.fields.length; i++) {
    const field = world.fields[i];
    if (!field.enabled || field.fx === null || field.fy === null) continue;
    try {
      const fx = field.fx(env);
      const fy = field.fy(env);
      add(entries, `field-${i}`, field.name || `Field ${i + 1}`, "field", fx, fy);
    } catch {
      // The engine skips a singular sample for this body; the ledger agrees.
    }
  }

  for (const link of world.links) {
    if (link instanceof DistanceLink && (link.a === body || link.b === body)) {
      const dx = link.b.pos.x - link.a.pos.x;
      const dy = link.b.pos.y - link.a.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-12) {
        const side = link.a === body ? 1 : -1;
        const fx = side * link.mu * dx / d;
        const fy = side * link.mu * dy / d;
        const label = link.isRope ? "String tension" :
          link.mu >= 0 ? "Rod tension" : "Rod thrust";
        add(entries, `distance-${link.id}`, label,
          link.isRope ? "string" : "rod", fx, fy);
      }
    } else if (link instanceof SpringLink && (link.a === body || link.b === body)) {
      const dx = link.b.pos.x - link.a.pos.x;
      const dy = link.b.pos.y - link.a.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-12) {
        const side = link.a === body ? 1 : -1;
        add(entries, `spring-${link.id}`,
          link.tensionOnly ? "Elastic-string tension" :
            link.axialForce >= 0 ? "Spring tension" : "Spring thrust",
          link.tensionOnly ? "string" : "spring",
          side * link.axialForce * dx / d,
          side * link.axialForce * dy / d);
      }
    } else if (link instanceof PulleyLink && (link.a === body || link.b === body)) {
      const geometry = link.geometry();
      const nx = link.a === body ? geometry.nax : geometry.nbx;
      const ny = link.a === body ? geometry.nay : geometry.nby;
      add(entries, `pulley-${link.id}`, "Pulley-string tension", "pulley",
        -link.mu * nx, -link.mu * ny);
    }
  }

  let namedX = 0;
  let namedY = 0;
  for (const entry of entries) {
    namedX += entry.fx;
    namedY += entry.fy;
  }
  // Before the first solver step there is no realised delta-v diagnostic yet.
  // Use the authored analytical sum rather than inventing an equal-and-
  // opposite residual that would make a freshly loaded force diagram read 0.
  const resultantX = world.stepCount === 0 ? namedX : body.netForce.x;
  const resultantY = world.stepCount === 0 ? namedY : body.netForce.y;
  const residualX = resultantX - namedX;
  const residualY = resultantY - namedY;
  add(entries, "reaction", "Contact / solver reaction", "reaction",
    residualX, residualY);

  return {
    entries,
    resultant: { fx: resultantX, fy: resultantY },
    basis: referenceWall === null ? null : slopeBasis(referenceWall, body),
  };
}

export interface PulleyAnalysis {
  linkId: number;
  tension: number;
  legRateA: number;
  legRateB: number;
  constraintRate: number;
  accelerationA: number;
  accelerationB: number;
  axleReactionX: number;
  axleReactionY: number;
  axleReaction: number;
  pathLength: number;
  naturalLength: number;
  slack: boolean;
}

export function analysePulley(link: PulleyLink): PulleyAnalysis {
  const g = link.geometry();
  const legRateA = link.a.vel.x * g.nax + link.a.vel.y * g.nay;
  const legRateB = link.b.vel.x * g.nbx + link.b.vel.y * g.nby;
  const invMassA = link.a.mass > 0 ? 1 / link.a.mass : 0;
  const invMassB = link.b.mass > 0 ? 1 / link.b.mass : 0;
  const accelerationA = (link.a.netForce.x * g.nax + link.a.netForce.y * g.nay) * invMassA;
  const accelerationB = (link.b.netForce.x * g.nbx + link.b.netForce.y * g.nby) * invMassB;
  // The two string legs pull the wheel outward along their straight sections;
  // the fixed axle supplies the equal and opposite reaction.
  const axleReactionX = -link.mu * (g.nax + g.nbx);
  const axleReactionY = -link.mu * (g.nay + g.nby);
  return {
    linkId: link.id,
    tension: Math.max(0, link.mu),
    legRateA,
    legRateB,
    constraintRate: legRateA + legRateB,
    accelerationA,
    accelerationB,
    axleReactionX,
    axleReactionY,
    axleReaction: Math.hypot(axleReactionX, axleReactionY),
    pathLength: g.totalLength,
    naturalLength: link.length,
    slack: g.totalLength < link.length - 1e-6,
  };
}

export type PlaybackEventKind =
  "contact" | "contact-end" | "apex" | "x-reversal" | "line-crossing" |
  "string-taut" | "string-slack" | "pulley-stop";

export interface PlaybackEvent {
  id: number;
  kind: PlaybackEventKind;
  time: number;
  label: string;
  bodyIds: number[];
  value: string;
  /** Fraction through the last observed interval for interpolable events. */
  fraction?: number;
  /** Stable contact identity used by deterministic event refinement. */
  key?: string;
}

interface BodySample { x: number; y: number; vx: number; vy: number }

/** Bounded transition detector used by the event table and auto-pause UI. */
export class EventTracker {
  readonly events: PlaybackEvent[] = [];
  selectedBodyId: number | null = null;
  lineAxis: "x" | "y" = "x";
  lineValue = 0;
  private nextId = 1;
  private bodies = new Map<number, BodySample>();
  private contacts = new Set<string>();
  private linkTaut = new Map<string, boolean>();
  private pulleyStops = new Set<string>();
  private primed = false;
  private sampleTime = 0;

  clear(world?: World): void {
    this.events.length = 0;
    this.nextId = 1;
    this.primed = false;
    if (world !== undefined) this.prime(world);
  }

  /** Remove future rows after frame rewind and restart transition detection
   * from the restored state. Retained row ids stay stable for keyed DOM
   * updates; the next id continues above the newest survivor. */
  rewindTo(time: number, world: World): void {
    let keep = 0;
    for (const event of this.events) {
      if (event.time <= time + 1e-9) this.events[keep++] = event;
    }
    this.events.length = keep;
    this.events.sort((a, b) => a.time - b.time || a.id - b.id);
    this.nextId = this.events.reduce((max, event) => Math.max(max, event.id), 0) + 1;
    this.prime(world);
  }

  prime(world: World): void {
    this.capture(world);
    this.primed = true;
  }

  /** Resume from the current state after an interval without observations. */
  prepareStep(world: World): void {
    if (!this.primed || this.sampleTime !== world.time) this.prime(world);
  }

  private push(event: Omit<PlaybackEvent, "id">): PlaybackEvent {
    const complete = { ...event, id: this.nextId++ };
    this.events.push(complete);
    return complete;
  }

  /** Detect transitions since the previous sample and return newly added rows. */
  observe(world: World): PlaybackEvent[] {
    if (!this.primed) {
      this.prime(world);
      return [];
    }
    const added: PlaybackEvent[] = [];
    const time = world.time;
    const interval = Math.max(0, time - this.sampleTime);
    const selected = this.selectedBodyId;
    for (const body of world.bodies) {
      if (body.isAnchor || body.isRodEndpoint) continue;
      const before = this.bodies.get(body.id);
      if (before === undefined) continue;
      if (before.vy > 1e-6 && body.vel.y <= 1e-6) {
        const fraction = before.vy / Math.max(1e-12, before.vy - body.vel.y);
        const clamped = Math.min(1, Math.max(0, fraction));
        added.push(this.push({ kind: "apex", time: this.sampleTime + clamped * interval,
          label: `${body.name} reached an apex`, bodyIds: [body.id],
          value: `vᵧ = 0 m/s`, fraction: clamped }));
      }
      if ((before.vx < -1e-6 && body.vel.x >= -1e-6) ||
          (before.vx > 1e-6 && body.vel.x <= 1e-6)) {
        const fraction = Math.min(1, Math.max(0,
          Math.abs(before.vx) / Math.max(1e-12, Math.abs(before.vx) + Math.abs(body.vel.x))));
        added.push(this.push({ kind: "x-reversal", time: this.sampleTime + fraction * interval,
          label: `${body.name} reversed horizontally`, bodyIds: [body.id],
          value: `vₓ = 0 m/s`, fraction }));
      }
      if (body.id === selected) {
          const a = this.lineAxis === "x" ? before.x : before.y;
          const b = this.lineAxis === "x" ? body.pos.x : body.pos.y;
        if ((a < this.lineValue && b >= this.lineValue) ||
            (a > this.lineValue && b <= this.lineValue)) {
          const fraction = Math.min(1, Math.max(0,
            (this.lineValue - a) / (b - a)));
          added.push(this.push({ kind: "line-crossing",
            time: this.sampleTime + fraction * interval,
            label: `${body.name} crossed ${this.lineAxis} = ${this.lineValue}`,
            bodyIds: [body.id], value: `${this.lineAxis} = ${this.lineValue.toFixed(3)} m`,
            fraction }));
        }
      }
    }

    const nextContacts = contactKeys(world);
    for (const key of nextContacts) {
      if (!this.contacts.has(key)) {
        added.push(this.push({ kind: "contact", time, label: "Contact began",
          bodyIds: contactBodyIds(key), value: contactValue(world, key), key }));
      }
    }
    for (const key of this.contacts) {
      if (!nextContacts.has(key)) {
        added.push(this.push({ kind: "contact-end", time, label: "Contact ended",
          bodyIds: contactBodyIds(key), value: "separated", key }));
      }
    }

    const nextTaut = linkTautStates(world);
    for (const [key, taut] of nextTaut) {
      const before = this.linkTaut.get(key);
      if (before === undefined || before === taut) continue;
      added.push(this.push({ kind: taut ? "string-taut" : "string-slack", time,
        label: `String became ${taut ? "taut" : "slack"}`, bodyIds: [],
        value: key }));
    }

    const nextStops = pulleyStopKeys(world);
    for (const key of nextStops) {
      if (!this.pulleyStops.has(key)) {
        const id = Number(key.split(":")[1]);
        added.push(this.push({ kind: "pulley-stop", time,
          label: "Particle reached the pulley stop", bodyIds: [id],
          value: "zero-restitution terminal stop" }));
      }
    }
    this.capture(world, nextContacts, nextTaut, nextStops);
    // Interpolated transitions are discovered in body-list order. Consumers
    // choose the first matching stop and retain chronological event history.
    added.sort((a, b) => a.time - b.time || a.id - b.id);
    this.events.sort((a, b) => a.time - b.time || a.id - b.id);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    return added;
  }

  private capture(world: World, contacts = contactKeys(world),
                  links = linkTautStates(world), stops = pulleyStopKeys(world)): void {
    this.bodies.clear();
    for (const body of world.bodies) {
      this.bodies.set(body.id, {
        x: body.pos.x, y: body.pos.y, vx: body.vel.x, vy: body.vel.y,
      });
    }
    this.contacts = contacts;
    this.linkTaut = links;
    this.pulleyStops = stops;
    this.sampleTime = world.time;
  }
}

/** Stable event identity shared by detection and automatic-pause refinement.
 * Explicit namespaces preserve ID zero and unordered body pairs. */
export function contactKey(contact: Contact): string {
  const a = contact.bodyAId;
  const b = contact.bodyBId;
  if (a !== undefined && a >= 0) {
    if (b !== null && b !== undefined && b >= 0) {
      return `body:${Math.min(a, b)}:${Math.max(a, b)}`;
    }
    if (contact.wallId !== null && contact.wallId !== undefined) {
      return `wall:${a}:${contact.wallId}`;
    }
  }
  return `point:${contact.px.toFixed(4)}:${contact.py.toFixed(4)}`;
}

function contactKeys(world: World): Set<string> {
  return new Set(world.contacts.map(contactKey));
}

function contactBodyIds(key: string): number[] {
  const parts = key.split(":");
  if (parts[0] === "body") return parts.slice(1).map(Number);
  return parts[0] === "wall" ? [Number(parts[1])] : [];
}

function contactValue(world: World, key: string): string {
  const parts = key.split(":");
  if (parts[0] !== "body" && parts[0] !== "wall") return "contact";
  const a = world.bodies.find((body) => body.id === Number(parts[1]));
  const other = Number(parts[2]);
  const b = parts[0] === "body"
    ? world.bodies.find((body) => body.id === other)
    : world.walls.find((wall) => wall.id === other);
  return [a?.name, b?.name].filter(Boolean).join(" with ") || "contact";
}

function linkTautStates(world: World): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const link of world.links) {
    if (link instanceof DistanceLink && link.isRope) {
      states.set(`inelastic string ${link.id}`,
        link.a.pos.distTo(link.b.pos) >= link.length - 1e-6);
    } else if (link instanceof SpringLink && link.tensionOnly) {
      states.set(`elastic string ${link.id}`,
        link.a.pos.distTo(link.b.pos) > link.restLength + 1e-6);
    } else if (link instanceof PulleyLink) {
      states.set(`pulley string ${link.id}`,
        link.geometry().totalLength >= link.length - 1e-6);
    }
  }
  return states;
}

function pulleyStopKeys(world: World): Set<string> {
  const stops = new Set<string>();
  for (const link of world.links) {
    if (!(link instanceof PulleyLink)) continue;
    const limit = link.pulley.radius + link.a.radius;
    if (link.a.pos.distTo(link.pulley.pos) <= limit + 1e-6) {
      stops.add(`stop:${link.a.id}:${link.id}`);
    }
    if (link.b.pos.distTo(link.pulley.pos) <= limit + 1e-6) {
      stops.add(`stop:${link.b.id}:${link.id}`);
    }
  }
  return stops;
}
