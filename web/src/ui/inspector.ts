/** Inspector: tabbed side panel editing the selection, world and view.
 *
 * Rebuilt whenever the selection structure changes; while the structure is
 * stable, controls refresh in place every frame so live values (positions,
 * velocities) stay current without stealing focus.
 */
import { App, GraphMode, Panel } from "../app";
import { Body, MATERIALS, Wall } from "../engine/body";
import { DistanceLink, SpringLink } from "../engine/links";
import { Driver, ForceField, INTEGRATORS, Integrator } from "../engine/world";
import { Selectable } from "../render/draw";
import { RefreshGroup, button, checkbox, el, fmt3dp, halfRow, numEdit, section,
         segmented, slider, textEdit } from "./dom";
import { ICONS } from "./icons";

const TABS = ["Selection", "World", "View"] as const;
type Tab = (typeof TABS)[number];

export class Inspector implements Panel {
  private app: App;
  private root: HTMLElement;
  private body: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = "Selection";
  private group = new RefreshGroup();
  private structureKey = "";
  private showFormulaHelp = false;
  private collapsed = false;
  private splitter: HTMLElement;
  private reopenStrip: HTMLElement;

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;

    // slim clickable strip shown while the panel is collapsed
    this.reopenStrip = el("div", { class: "reopen-strip",
                                   title: "Show the panel (Tab)" });
    this.reopenStrip.insertAdjacentHTML("beforeend", ICONS.chev_left);
    this.reopenStrip.hidden = true;
    this.reopenStrip.addEventListener("click", () => this.toggleCollapsed());
    root.append(this.reopenStrip);

    const tabs = el("div", { class: "tabs" });
    for (const t of TABS) {
      const b = el("button", { text: t });
      b.addEventListener("click", () => {
        this.tab = t;
        this.rebuild();
      });
      this.tabBtns.set(t, b);
      tabs.append(b);
    }
    const collapseBtn = el("button", { class: "collapse-btn",
                                       title: "Hide the panel (Tab)" });
    collapseBtn.insertAdjacentHTML("beforeend", ICONS.chev_right);
    collapseBtn.addEventListener("click", () => this.toggleCollapsed());
    tabs.append(collapseBtn);
    this.body = el("div", { class: "inspector-body" });
    root.append(tabs, this.body);

    // width splitter (persisted)
    const saved = app.settings.inspector_w;
    if (typeof saved === "number") root.style.width = `${Math.max(240, saved)}px`;
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = Math.max(240, Math.min(620, window.innerWidth - e.clientX));
      root.style.width = `${w}px`;
      app.resizeCanvas();
    });
    splitter.addEventListener("pointerup", () => {
      dragging = false;
      app.settings.inspector_w = root.clientWidth;
      app.saveSettings();
    });

    app.onSelectionChange = () => {
      if (this.tab === "Selection") this.markDirty();
      else this.refreshStructure();
    };
    app.onWorldReplaced = () => this.markDirty();
    this.rebuild();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.root.classList.toggle("collapsed", this.collapsed);
    this.root.classList.toggle("mobile-open", !this.collapsed &&
      window.matchMedia("(max-width: 760px)").matches);
    this.body.hidden = this.collapsed;
    (this.root.querySelector(".tabs") as HTMLElement).hidden = this.collapsed;
    this.reopenStrip.hidden = !this.collapsed;
    this.splitter.hidden = this.collapsed; // no resizing while collapsed
    if (this.collapsed) {
      this.root.style.removeProperty("width"); // let .collapsed set the width
    } else if (typeof this.app.settings.inspector_w === "number") {
      this.root.style.width = `${Math.max(240, this.app.settings.inspector_w)}px`;
    }
    this.app.resizeCanvas();
    if (this.collapsed) {
      this.app.toast("Panel hidden - press Tab or click the right edge to reopen");
    }
  }

  private dirty = false;

  markDirty(): void {
    this.dirty = true;
  }

  /** Key describing what the panel is editing; rebuild when it changes. */
  private computeStructureKey(): string {
    const app = this.app;
    if (this.tab !== "Selection") {
      // World tab structure depends on fields/drivers/mutual gravity
      if (this.tab === "World") {
        return `world:${app.world.fields.length}:${app.world.drivers.length}:` +
               `${app.world.mutualGravity}:${this.showFormulaHelp}:` +
               app.world.fields.map((f) => f.error).join("|");
      }
      return this.tab;
    }
    const sel = app.selection;
    const ids = sel.map((o) => `${o.constructor.name}${(o as { id: number }).id}`).join(",");
    const drivers = app.world.drivers.map((d) => d.bodyId).join(",");
    return `sel:${ids}:${drivers}`;
  }

  private refreshStructure(): void {
    const key = this.computeStructureKey();
    if (key !== this.structureKey || this.dirty) {
      this.dirty = false;
      this.rebuild();
    }
  }

  refresh(): void {
    if (this.collapsed) return;
    this.refreshStructure();
    this.group.refreshAll();
  }

  private commit = (): void => {
    this.app.pushUndo();
  };

  // ------------------------------------------------------------------ build
  private rebuild(): void {
    this.structureKey = this.computeStructureKey();
    this.group.clear();
    this.body.replaceChildren();
    for (const [t, b] of this.tabBtns) b.classList.toggle("active", t === this.tab);
    if (this.tab === "Selection") this.buildSelection();
    else if (this.tab === "World") this.buildWorld();
    else this.buildView();
    this.group.refreshAll();
  }

  private add(c: { root: HTMLElement; refresh?: () => void }): void {
    this.body.append(this.group.add(c).root);
  }

  private addHalf(a: { root: HTMLElement; refresh?: () => void },
                  b: { root: HTMLElement; refresh?: () => void }): void {
    this.group.add(a);
    this.group.add(b);
    this.body.append(halfRow(a.root, b.root));
  }

  // -------------------------------------------------------------- selection
  private buildSelection(): void {
    const app = this.app;
    const sel = app.selection;
    if (sel.length === 0) {
      for (const line of ["Nothing selected.", "",
                          "Click an object with the Select tool,",
                          "or drag a box around several objects.",
                          "Shift-click adds to the selection."]) {
        this.body.append(el("div", { class: "dim", text: line,
                                     style: "min-height:15px" }));
      }
      this.body.append(section("Box select picks up"));
      const flt = app.boxFilter;
      const rows: Array<[keyof typeof flt, string]> = [
        ["bodies", "Bodies / particles"], ["anchors", "Anchors"], ["walls", "Walls"],
        ["springs", "Springs & strings"], ["rods", "Rods"],
      ];
      for (const [key, label] of rows) {
        this.add(checkbox(label, () => flt[key], (v) => { flt[key] = v; },
          "Object types included when you drag a selection box"));
      }
      const world = app.world;
      const groups: Array<[Selectable[], string]> = [
        [world.bodies.filter((b) => !b.isAnchor), "bodies"],
        [world.bodies.filter((b) => b.isAnchor), "anchors"],
        [world.walls, "walls"],
        [world.links.filter((l) => l instanceof SpringLink), "springs & strings"],
        [world.links.filter((l) => l instanceof DistanceLink), "rods"],
      ];
      const nonEmpty = groups.filter(([g]) => g.length > 0);
      if (nonEmpty.length > 0) {
        this.body.append(section("Delete every ..."));
        for (const [grp, lbl] of nonEmpty) {
          this.add(button(`All ${lbl} (${grp.length})`,
            () => this.deleteObjs([...grp], lbl),
            { style: "danger",
              tooltip: `Remove every ${lbl} in the scene (undo with Ctrl+Z)` }));
        }
      }
      return;
    }
    if (sel.length === 1 && sel[0] instanceof Body) {
      if (sel[0].isAnchor) this.buildSingleAnchor(sel[0]);
      else this.buildSingleBody(sel[0]);
    } else if (sel.length === 1 && sel[0] instanceof Wall) this.buildWall(sel[0]);
    else if (sel.length === 1) this.buildLink(sel[0] as DistanceLink | SpringLink);
    else this.buildMulti(sel);
  }

  private nameEdit(obj: { name: string }): void {
    this.add(textEdit(() => obj.name, (s) => {
      obj.name = s.trim() || obj.name;
      this.commit();
      return true;
    }, "name"));
  }

  private buildSingleBody(b: Body): void {
    const app = this.app;
    this.nameEdit(b);
    this.add(slider("Mass", () => b.mass, (v) => { b.mass = v; },
      0.001, 10000.0, { unit: "kg", log: true, onCommit: this.commit,
        tooltip: "Inertial (and gravitational) mass m" }));
    this.add(slider("Radius", () => b.radius, (v) => { b.radius = v; },
      0.01, 10.0, { unit: "m", log: true, onCommit: this.commit,
        tooltip: "Collision radius (mass is independent of size here)" }));
    this.addHalf(
      numEdit("x", () => b.pos.x, (v) => { b.pos.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y", () => b.pos.y, (v) => { b.pos.y = v; }, "m", this.commit, fmt3dp));
    this.addHalf(
      numEdit("vx", () => b.vel.x, (v) => { b.vel.x = v; }, "", this.commit, fmt3dp),
      numEdit("vy", () => b.vel.y, (v) => { b.vel.y = v; }, "", this.commit, fmt3dp));
    this.add(slider("Spin", () => b.omega, (v) => { b.omega = v; },
      -100.0, 100.0, { unit: "rad/s", fmt: (v) => v.toFixed(2), onCommit: this.commit,
        disabled: () => b.noRotation,
        tooltip: "Angular velocity omega about the body's centre " +
                 "(disabled while No rotation is on)" }));
    this.addHalf(
      checkbox("Locked", () => b.locked, (v) => { b.locked = v; this.commit(); },
        "A locked body never moves: use as pivot or anchor (K)"),
      checkbox("Collides", () => b.collides, (v) => { b.collides = v; this.commit(); },
        "Disable to let this body pass through others"));
    this.add(checkbox("No rotation", () => b.noRotation,
      (v) => { b.noRotation = v; if (v) b.omega = 0.0; this.commit(); },
      "Body can't spin (infinite rotational inertia): it behaves like a " +
      "point particle, so friction can hold it in limiting equilibrium on a " +
      "slope (mu >= tan theta) instead of rolling"));

    this.body.append(section("Material"));
    this.add(slider("Bounce", () => b.restitution, (v) => { b.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Coefficient of restitution e: fraction of approach speed " +
                 "kept after a bounce (1 = perfectly elastic, 0 = perfectly inelastic)" }));
    this.add(slider("Friction", () => b.friction, (v) => { b.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Coefficient of friction mu (Coulomb model: |F_t| <= mu N)" }));
    this.materialButtons([b]);

    this.body.append(section("Constant force"));
    this.addHalf(
      numEdit("Fx", () => b.constForce.x, (v) => { b.constForce.x = v; }, "N", this.commit),
      numEdit("Fy", () => b.constForce.y, (v) => { b.constForce.y = v; }, "N", this.commit));

    const drv = this.app.world.drivers.find((d) => d.bodyId === b.id);
    this.body.append(section("Driving force"));
    if (drv === undefined) {
      this.add(button("Add sinusoidal driver", () => {
        app.world.drivers.push(new Driver(b.id));
        app.pushUndo();
        this.markDirty();
      }, { icon: ICONS.plus, tooltip: "Apply F = A sin(2 pi f t) to this body" }));
    } else {
      this.driverControls([drv]);
      this.add(button("Remove driver", () => {
        app.world.drivers = app.world.drivers.filter((d) => d !== drv);
        app.pushUndo();
        this.markDirty();
      }, { icon: ICONS.trash, style: "danger" }));
    }

    this.actionButtons();
  }

  /** An anchor is a fixed attachment point: only its size, position, whether
   * it collides, and its material matter. No mass, motion, name or forces. */
  private buildSingleAnchor(b: Body): void {
    this.body.append(el("div", { text: "Anchor",
      style: "font-weight:600;margin-bottom:6px" }));
    this.add(slider("Radius", () => b.radius, (v) => { b.radius = v; },
      0.01, 10.0, { unit: "m", log: true, onCommit: this.commit,
        tooltip: "Collision radius of the anchor" }));
    this.addHalf(
      numEdit("x", () => b.pos.x, (v) => { b.pos.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y", () => b.pos.y, (v) => { b.pos.y = v; }, "m", this.commit, fmt3dp));
    this.add(checkbox("Collides", () => b.collides, (v) => { b.collides = v; this.commit(); },
      "Disable to let bodies pass through this anchor"));

    this.body.append(section("Material"));
    this.add(slider("Bounce", () => b.restitution, (v) => { b.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Coefficient of restitution e for bodies bouncing off this anchor" }));
    this.add(slider("Friction", () => b.friction, (v) => { b.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Coefficient of friction mu at contact with this anchor" }));
    this.materialButtons([b]);

    this.actionButtons();
  }

  private materialButtons(bodies: Body[]): void {
    const grid = el("div", { class: "btn-grid" });
    for (const [name, [e, mu]] of Object.entries(MATERIALS)) {
      if (name === "Custom") continue;
      const b = button(name, () => {
        for (const body of bodies) {
          body.restitution = e;
          body.friction = mu;
        }
        this.commit();
      }, { tooltip: `bounce ${e}, friction ${mu}` });
      grid.append(b.root);
    }
    this.body.append(grid);
  }

  private driverControls(drvs: Driver[]): void {
    const first = drvs[0];
    this.add(slider("Amplitude", () => first.amplitude,
      (v) => drvs.forEach((d) => { d.amplitude = v; }), 0.0, 500.0,
      { unit: "N", fmt: (v) => v.toFixed(2), onCommit: this.commit }));
    this.add(slider("Frequency", () => first.frequency,
      (v) => drvs.forEach((d) => { d.frequency = v; }), 0.001, 100.0,
      { unit: "Hz", log: true, onCommit: this.commit }));
    this.add(slider("Direction", () => (first.angle * 180) / Math.PI,
      (v) => drvs.forEach((d) => { d.angle = (v * Math.PI) / 180; }), -180.0, 180.0,
      { unit: "deg", fmt: (v) => v.toFixed(0), onCommit: this.commit }));
  }

  /** Bulk editor for a mixed selection: every type present gets its own
   * section, and each control writes to all selected objects of that type. */
  private buildMulti(sel: Selectable[]): void {
    const bodies = sel.filter((o): o is Body => o instanceof Body && !o.isAnchor);
    const anchors = sel.filter((o): o is Body => o instanceof Body && o.isAnchor);
    const walls = sel.filter((o): o is Wall => o instanceof Wall);
    const springs = sel.filter((o): o is SpringLink => o instanceof SpringLink);
    const rods = sel.filter((o): o is DistanceLink => o instanceof DistanceLink);
    const parts: string[] = [];
    if (bodies.length) parts.push(`${bodies.length} ${bodies.length !== 1 ? "bodies" : "body"}`);
    if (anchors.length) parts.push(`${anchors.length} anchor${anchors.length !== 1 ? "s" : ""}`);
    if (walls.length) parts.push(`${walls.length} wall${walls.length !== 1 ? "s" : ""}`);
    if (springs.length) parts.push(`${springs.length} spring/string${springs.length !== 1 ? "s" : ""}`);
    if (rods.length) parts.push(`${rods.length} rod${rods.length !== 1 ? "s" : ""}`);
    this.body.append(el("div", { text: parts.join(", ") + " selected",
      style: "font-weight:600;margin-bottom:6px" }));

    if (bodies.length > 0) {
      const first = bodies[0];
      this.body.append(section(`Bodies (${bodies.length})`));
      this.add(slider("Mass", () => first.mass,
        (v) => bodies.forEach((b) => { b.mass = v; }), 0.001, 10000.0,
        { unit: "kg", log: true, onCommit: this.commit }));
      this.add(slider("Radius", () => first.radius,
        (v) => bodies.forEach((b) => { b.radius = v; }), 0.01, 10.0,
        { unit: "m", log: true, onCommit: this.commit }));
      this.add(slider("Bounce", () => first.restitution,
        (v) => bodies.forEach((b) => { b.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Coefficient of restitution e, applied to every selected body" }));
      this.add(slider("Friction", () => first.friction,
        (v) => bodies.forEach((b) => { b.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Coefficient of friction mu, applied to every selected body" }));
      this.materialButtons(bodies);
      this.addHalf(
        checkbox("Locked", () => first.locked,
          (v) => { bodies.forEach((b) => { b.locked = v; }); this.commit(); },
          "Lock / unlock every selected body"),
        checkbox("Collides", () => first.collides,
          (v) => { bodies.forEach((b) => { b.collides = v; }); this.commit(); },
          "Enable / disable collisions for every selected body"));
      this.add(checkbox("No rotation", () => first.noRotation,
        (v) => { bodies.forEach((b) => { b.noRotation = v; if (v) b.omega = 0.0; });
                 this.commit(); },
        "Stop every selected body from spinning: each behaves like a point " +
        "particle (can rest in limiting equilibrium on a slope)"));
      this.body.append(section("Constant force"));
      this.addHalf(
        numEdit("Fx", () => first.constForce.x,
          (v) => bodies.forEach((b) => { b.constForce.x = v; }), "N", this.commit),
        numEdit("Fy", () => first.constForce.y,
          (v) => bodies.forEach((b) => { b.constForce.y = v; }), "N", this.commit));
      this.buildMultiDrivers(bodies);
      if (bodies.length >= 2) {
        this.body.append(section("Align"));
        const grid = el("div", { class: "btn-grid-4" });
        const items: Array<[string, string, () => void]> = [
          ["|x", "Align to the same x", () => this.align(bodies, "x")],
          ["y—", "Align to the same y", () => this.align(bodies, "y")],
          ["↔", "Space evenly in x", () => this.distribute(bodies, "x")],
          ["↕", "Space evenly in y", () => this.distribute(bodies, "y")],
        ];
        for (const [label, tip, fn] of items) {
          grid.append(button(label, fn, { tooltip: tip }).root);
        }
        this.body.append(grid);
      }
    }

    if (anchors.length > 0) {
      const af = anchors[0];
      this.body.append(section(`Anchors (${anchors.length})`));
      this.add(slider("Radius", () => af.radius,
        (v) => anchors.forEach((a) => { a.radius = v; }), 0.01, 10.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Collision radius, applied to every selected anchor" }));
      this.add(slider("Bounce", () => af.restitution,
        (v) => anchors.forEach((a) => { a.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Coefficient of restitution e, applied to every selected anchor" }));
      this.add(slider("Friction", () => af.friction,
        (v) => anchors.forEach((a) => { a.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Coefficient of friction mu, applied to every selected anchor" }));
      this.materialButtons(anchors);
      this.add(checkbox("Collides", () => af.collides,
        (v) => { anchors.forEach((a) => { a.collides = v; }); this.commit(); },
        "Enable / disable collisions for every selected anchor"));
    }

    if (walls.length > 0) {
      const wf = walls[0];
      this.body.append(section(`Walls (${walls.length})`));
      this.add(slider("Thickness", () => wf.thickness,
        (v) => walls.forEach((w) => { w.thickness = v; }), 0.01, 2.0,
        { unit: "m", log: true, fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.add(slider("Bounce", () => wf.restitution,
        (v) => walls.forEach((w) => { w.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.add(slider("Friction", () => wf.friction,
        (v) => walls.forEach((w) => { w.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
    }

    if (springs.length > 0) {
      const sf = springs[0];
      this.body.append(section(`Springs & strings (${springs.length})`));
      this.add(slider("Stiffness", () => sf.stiffness,
        (v) => springs.forEach((s) => { s.stiffness = v; }), 0.01, 100000.0,
        { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Spring constant k, applied to every selected spring/string" }));
      this.add(slider("Damping", () => sf.damping,
        (v) => springs.forEach((s) => { s.damping = v; }), 0.0, 500.0,
        { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Damping coefficient c, applied to every selected spring/string" }));
    }

    this.actionButtons();
    // selective deletion: remove just one kind of thing from the selection
    const groups: Array<[Selectable[], string]> = [
      [bodies, "bodies"], [anchors, "anchors"], [walls, "walls"],
      [springs, "springs"], [rods, "rods"],
    ];
    const nonEmpty = groups.filter(([g]) => g.length > 0);
    if (nonEmpty.length >= 2) {
      this.body.append(section("Delete only ..."));
      const grid = el("div", { class: "btn-grid-2" });
      for (const [grp, lbl] of nonEmpty) {
        grid.append(button(`${lbl[0].toUpperCase()}${lbl.slice(1)} (${grp.length})`,
          () => this.deleteObjs([...grp], lbl),
          { style: "danger",
            tooltip: `Delete only the selected ${lbl}, keeping everything else` }).root);
      }
      this.body.append(grid);
    }
  }

  /** Edit the sinusoidal drivers of every selected body at once. */
  private buildMultiDrivers(bodies: Body[]): void {
    const app = this.app;
    const ids = new Set(bodies.map((b) => b.id));
    const drvs = app.world.drivers.filter((d) => ids.has(d.bodyId));
    this.body.append(section(`Driving force (${drvs.length}/${bodies.length} driven)`));
    const addAll = () => {
      const driven = new Set(app.world.drivers.map((d) => d.bodyId));
      for (const b of bodies) {
        if (!driven.has(b.id) && !b.locked) app.world.drivers.push(new Driver(b.id));
      }
      app.pushUndo();
      this.markDirty();
    };
    if (drvs.length === 0) {
      this.add(button("Add driver to all selected", addAll,
        { icon: ICONS.plus, tooltip: "Apply F = A sin(2 pi f t) to every selected body" }));
      return;
    }
    this.driverControls(drvs);
    const grid = el("div", { class: "btn-grid-2" });
    if (drvs.length < bodies.length) {
      grid.append(button("Drive rest", addAll,
        { tooltip: "Add drivers to the selected bodies that lack one" }).root);
    }
    grid.append(button("Remove all", () => {
      app.world.drivers = app.world.drivers.filter((d) => !drvs.includes(d));
      app.pushUndo();
      this.markDirty();
    }, { style: "danger", tooltip: "Remove every selected body's driver" }).root);
    this.body.append(grid);
  }

  private deleteObjs(objs: Selectable[], label: string): void {
    for (const o of objs) this.app.controller.deleteObject(o);
    this.app.pushUndo();
    this.app.toast(`Deleted ${objs.length} ${label} - Ctrl+Z restores them`);
    this.markDirty();
  }

  private align(bodies: Body[], axis: "x" | "y"): void {
    const avg = bodies.reduce((s, b) => s + b.pos[axis], 0) / bodies.length;
    for (const b of bodies) b.pos[axis] = avg;
    this.app.pushUndo();
  }

  private distribute(bodies: Body[], axis: "x" | "y"): void {
    if (bodies.length < 3) return;
    const ordered = [...bodies].sort((a, b) => a.pos[axis] - b.pos[axis]);
    const lo = ordered[0].pos[axis];
    const hi = ordered[ordered.length - 1].pos[axis];
    ordered.forEach((b, i) => {
      b.pos[axis] = lo + ((hi - lo) * i) / (ordered.length - 1);
    });
    this.app.pushUndo();
  }

  private buildWall(w: Wall): void {
    this.nameEdit(w);
    this.addHalf(
      numEdit("x1", () => w.a.x, (v) => { w.a.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y1", () => w.a.y, (v) => { w.a.y = v; }, "m", this.commit, fmt3dp));
    this.addHalf(
      numEdit("x2", () => w.b.x, (v) => { w.b.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y2", () => w.b.y, (v) => { w.b.y = v; }, "m", this.commit, fmt3dp));
    this.add(slider("Thickness", () => w.thickness, (v) => { w.thickness = v; },
      0.01, 2.0, { unit: "m", log: true, fmt: (v) => v.toFixed(2), onCommit: this.commit }));
    this.add(slider("Bounce", () => w.restitution, (v) => { w.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
    this.add(slider("Friction", () => w.friction, (v) => { w.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
    this.actionButtons();
  }

  /** Swap a link object in place (elastic string <-> inelastic string). */
  private replaceLink(oldLink: SpringLink | DistanceLink,
                      newLink: SpringLink | DistanceLink): void {
    const world = this.app.world;
    const i = world.links.indexOf(oldLink);
    if (i >= 0) world.links[i] = newLink;
    this.app.setSelection([newLink]);
    this.app.pushUndo();
  }

  private buildLink(link: SpringLink | DistanceLink): void {
    const app = this.app;
    if (link instanceof SpringLink) {
      const isString = link.tensionOnly;
      this.body.append(el("div", { text: isString ? "String (elastic)" : "Spring",
        style: "font-weight:600;margin-bottom:6px" }));
      this.add(slider("Nat. len", () => link.restLength, (v) => { link.restLength = v; },
        0.01, 50.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Natural (rest) length L0: the length at which it exerts no force" }));
      this.add(slider("Stiffness", () => link.stiffness, (v) => { link.stiffness = v; },
        0.01, 100000.0, { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Spring constant k (Hooke's law F = -k times extension)" }));
      this.add(slider("Damping", () => link.damping, (v) => { link.damping = v; },
        0.0, 500.0, { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Damping coefficient c: axial force F = -c times the stretch rate" }));
      if (isString) {
        this.add(checkbox("Inelastic (fixed length)", () => false,
          () => this.replaceLink(link,
            new DistanceLink(link.a, link.b, link.restLength, true)),
          "Replace with a perfectly inelastic string: rigid at its natural " +
          "length when taut, still slack when shorter"));
      }
    } else {
      this.body.append(el("div", { text: link.isRope ? "String (inelastic)" : "Rod",
        style: "font-weight:600;margin-bottom:6px" }));
      this.add(slider("Nat. len", () => link.length, (v) => { link.length = v; },
        0.01, 100.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: link.isRope ? "Natural length L0: rigid when taut, free when slack"
                               : "Rigid length the rod maintains" }));
      if (link.isRope) {
        this.add(checkbox("Inelastic (fixed length)", () => true,
          () => this.replaceLink(link,
            new SpringLink(link.a, link.b, link.length, 1000.0, 2.0, true)),
          "Untick to make the string elastic: it stretches under load " +
          "following Hooke's law (adds stiffness and damping)"));
      }
    }
    this.add(button("Delete", () => app.controller.deleteSelection(),
      { icon: ICONS.trash, style: "danger" }));
  }

  private actionButtons(): void {
    const app = this.app;
    this.body.append(section("Actions"));
    const g1 = el("div", { class: "btn-grid-2" });
    g1.append(button("Duplicate", () => app.controller.duplicateSelection(),
      { tooltip: "Copy the selection (Ctrl+D)" }).root);
    g1.append(button("Delete", () => app.controller.deleteSelection(),
      { style: "danger", tooltip: "Remove the selection (Del)" }).root);
    this.body.append(g1);
    const g2 = el("div", { class: "btn-grid-2" });
    g2.append(button("Copy props", () => app.copyProps(),
      { tooltip: "Copy material and physical properties (Ctrl+C)" }).root);
    const paste = this.group.add(button("Paste props", () => app.pasteProps(),
      { isEnabled: () => app.clipboardProps !== null,
        tooltip: "Apply copied properties to the selection (Ctrl+V)" }));
    g2.append(paste.root);
    this.body.append(g2);
  }

  // ------------------------------------------------------------------ world
  private buildWorld(): void {
    const app = this.app;
    const world = app.world;
    this.body.append(section("Gravity"));
    this.add(slider("g", () => world.gravity, (v) => { world.gravity = v; },
      -100.0, 100.0, { unit: "m/s²", fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Gravitational field strength g (uniform, downward). " +
                 "9.81 = Earth, 24.8 = Jupiter, 0 = space, negative = upward" }));
    this.add(checkbox("Bodies attract each other", () => world.mutualGravity,
      (v) => { world.mutualGravity = v; this.commit(); this.markDirty(); },
      "Newtonian N-body gravity for orbital mechanics"));
    if (world.mutualGravity) {
      this.add(slider("G", () => world.G, (v) => { world.G = v; },
        0.0001, 100000.0, { log: true, onCommit: this.commit,
          tooltip: "Gravitational constant (scaled units)" }));
      this.add(slider("Softening", () => world.softening, (v) => { world.softening = v; },
        0.0001, 2.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Smooths the force at tiny separations" }));
      this.add(checkbox("Point-mass gravity", () => world.pointGravity,
        (v) => { world.pointGravity = v; this.commit(); },
        "On: each body's whole mass acts from its centre, so overlapping " +
        "bodies can slingshot to extreme speeds. Off: bodies attract like " +
        "solid uniform discs - inside an overlap the pull fades to zero at " +
        "the centre, as in reality."));
    }

    this.body.append(section("Air & damping"));
    this.add(slider("Linear drag", () => world.dragLinear, (v) => { world.dragLinear = v; },
      0.0, 20.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "F = -c v (Stokes drag)" }));
    this.add(slider("Quad. drag", () => world.dragQuadratic,
      (v) => { world.dragQuadratic = v; }, 0.0, 20.0,
      { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "F = -c |v| v (aerodynamic drag)" }));
    this.add(slider("Damping", () => world.globalDamping,
      (v) => { world.globalDamping = v; }, 0.0, 20.0,
      { unit: "1/s", fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Exponential decay applied to all velocities" }));

    this.body.append(section("Solver"));
    const short: Record<Integrator, string> = {
      "Velocity Verlet": "Verlet", "Symplectic Euler": "Euler", RK4: "RK4",
    };
    const rev: Record<string, Integrator> = {};
    for (const i of INTEGRATORS) rev[short[i]] = i;
    this.add(segmented(Object.values(short), () => short[world.integrator],
      (v) => { world.integrator = rev[v]; this.commit(); },
      "Verlet: symplectic, best all-round choice. Euler: fastest, less " +
      "accurate. RK4: highest short-term accuracy for smooth forces."));
    this.add(slider("Substeps", () => world.substeps,
      (v) => { world.substeps = Math.round(v); }, 1, 64,
      { fmt: (v) => v.toFixed(0), step: 1, log: true, onCommit: this.commit,
        tooltip: "Physics substeps per 1/120 s step: more = more accurate " +
                 "but slower. Takes effect immediately." }));
    this.add(slider("Iterations", () => world.iterations,
      (v) => { world.iterations = Math.round(v); }, 1, 64,
      { fmt: (v) => v.toFixed(0), step: 1, log: true, onCommit: this.commit,
        tooltip: "Solver iterations per substep for links and contacts " +
                 "(they exit early once converged)" }));
    this.add(checkbox("Adaptive resolution", () => app.adaptiveDt,
      (v) => app.setAdaptiveDt(v),
      "Automatically run extra, smaller physics steps during fast close " +
      "encounters (gravity slingshots, whipping pendulums), as long as the " +
      "frame rate can afford it. Keeps trajectories and motion trails smooth."));

    this.body.append(section("Custom force fields"));
    for (const field of [...world.fields]) {
      // enabled toggle + editable name on one row (the name is saved with
      // the scene, so it survives save/export like everything else)
      const nameRow = el("div", { class: "row" });
      const chk = this.group.add(checkbox("", () => field.enabled,
        (v) => { field.enabled = v; this.commit(); },
        "Enable / disable this force field"));
      const nameEd = this.group.add(textEdit(() => field.name, (s) => {
        field.name = s.trim() || field.name;
        this.commit();
        return true;
      }, "field name"));
      nameEd.root.style.flex = "1";
      nameRow.append(chk.root, nameEd.root);
      this.body.append(nameRow);
      for (const attr of ["fxSrc", "fySrc"] as const) {
        const row = el("div", { class: "num-row" });
        row.append(el("span", { class: "lbl", text: attr === "fxSrc" ? "Fx" : "Fy" }));
        const edit = this.group.add(textEdit(() => field[attr], (s) => {
          // keep the text either way so the user can fix it; a bad
          // expression just disables the field and shows the error
          field[attr] = s;
          const ok = field.compile();
          if (ok) app.pushUndo();
          this.markDirty();
          return ok;
        }, "e.g. -0.5*vx or -x*10"));
        row.append(edit.root);
        this.body.append(row);
      }
      if (field.error) {
        this.body.append(el("div", { class: "error-text", text: field.error }));
      }
      this.add(button("Remove field", () => {
        world.fields = world.fields.filter((f) => f !== field);
        this.commit();
        this.markDirty();
      }, { icon: ICONS.trash, style: "danger" }));
    }
    const addBtn = this.group.add(button("Add force field", () => {
      world.fields.push(new ForceField(`Field ${world.fields.length + 1}`, "0", "0"));
      app.pushUndo();
      this.markDirty();
    }, { icon: ICONS.plus,
         tooltip: "A force (in N) applied to every body, written as plain " +
                  "math. Try Fy = -y*5 for a spring field." }));
    const refBtn = this.group.add(button(
      this.showFormulaHelp ? "Hide formula reference" : "Formula reference",
      () => {
        this.showFormulaHelp = !this.showFormulaHelp;
        this.markDirty();
      }, { style: "ghost", isActive: () => this.showFormulaHelp,
           tooltip: "Every variable, function and operator you can use in " +
                    "force-field formulas" }));
    this.body.append(el("div", { class: "field-actions" }, addBtn.root, refBtn.root));
    if (this.showFormulaHelp) this.buildFormulaReference();

    if (world.drivers.length > 0) {
      this.body.append(section("Drivers"));
      for (const drv of [...world.drivers]) {
        const body = world.bodyById(drv.bodyId);
        const name = body ? body.name : `body ${drv.bodyId}`;
        const row = el("div", { class: "row" });
        const chk = this.group.add(checkbox(
          `${name}: ${drv.amplitude.toFixed(1)} N @ ${drv.frequency.toFixed(2)} Hz`,
          () => drv.enabled, (v) => { drv.enabled = v; this.commit(); }));
        chk.root.style.flex = "1";
        row.append(chk.root);
        row.append(button("", () => {
          world.drivers = world.drivers.filter((d) => d !== drv);
          this.commit();
          this.markDirty();
        }, { icon: ICONS.close, style: "ghost" }).root);
        this.body.append(row);
      }
    }
  }

  /** The in-panel cheat sheet for force-field formulas. */
  private buildFormulaReference(): void {
    const table = (rows: Array<[string, string]>): HTMLElement => {
      const t = el("table", { class: "formula-ref" });
      for (const [code, desc] of rows) {
        t.append(el("tr", {},
          el("td", { class: "code", text: code }),
          el("td", { class: "desc", text: desc })));
      }
      return t;
    };
    this.body.append(section("Examples"), table([
      ["-0.5*vx", "drag along x"],
      ["-10*x", "spring toward x = 0"],
      ["3*sin(2*t)", "oscillating push"],
      ["-5*x/r^3", "inverse-square pull"],
      ["-0.4*m*(y > 2)", "only above y = 2"],
    ]));
    this.body.append(section("Variables"), table([
      ["x,  y", "position (m)"],
      ["vx,  vy", "velocity (m/s)"],
      ["t", "time (s)"],
      ["m", "mass (kg)"],
      ["r", "distance from (0, 0)  (m)"],
    ]));
    this.body.append(section("Functions"), table([
      ["sin cos tan", "asin acos atan atan2"],
      ["sqrt exp log", "abs sign hypot"],
      ["min(a, b, ...)", "max floor ceil"],
    ]));
    this.body.append(section("Constants & operators"), table([
      ["pi  e  tau  g", "3.1416..., 2.7183..., 2*pi, 9.81"],
      ["+ - * / %", "arithmetic"],
      ["^  or  **", "power: x^2 is x squared"],
      ["(m > 1)", "comparisons give 1 or 0"],
      ["a if y > 0 else b", "a true either/or"],
    ]));
    this.body.append(el("div", { class: "faint",
      text: "The force is in newtons, applied to every body. Anything not " +
            "listed above is rejected and the error shows in red under the field.",
      style: "font-size:11px;margin-top:6px;line-height:1.5" }));
  }

  // ------------------------------------------------------------------- view
  private buildView(): void {
    const app = this.app;
    const view = app.view;
    const chk = (label: string, get: () => boolean, set: (v: boolean) => void,
                 tip = "") => this.add(checkbox(label, get, set, tip));

    this.body.append(section("Canvas"));
    chk("Grid", () => view.grid, (v) => { view.grid = v; });
    chk("Snap to grid", () => view.snap, (v) => { view.snap = v; },
        "New and dragged objects snap to grid points (N)");
    chk("Body labels", () => view.labels, (v) => { view.labels = v; });
    chk("Follow selection", () => view.follow, (v) => { view.follow = v; },
        "Keep the camera centred on the selected body (C). Zoom-to-fit and " +
        "the auto-fit camera live in the toolbar.");

    this.body.append(section("Vectors"));
    chk("Velocity vectors", () => view.velVectors, (v) => { view.velVectors = v; },
        "Green arrows (also editable by dragging) (D)");
    chk("Acceleration vectors", () => view.accVectors, (v) => { view.accVectors = v; },
        "Orange arrows");
    chk("Net force vectors", () => view.forceVectors, (v) => { view.forceVectors = v; },
        "Red arrows: F = ma");
    this.add(slider("Vector size", () => view.vectorScale,
      (v) => { view.vectorScale = v; }, 0.02, 20.0,
      { unit: "x", log: true, fmt: (v) => v.toFixed(2) }));

    this.body.append(section("Analysis"));
    this.add(checkbox("Motion trails", () => view.trails, (v) => app.setTrails(v),
      "Fading path behind each moving body (T)"));
    this.add(slider("Trail length", () => view.trailLen,
      (v) => { view.trailLen = Math.round(v); }, 10, 10000,
      { unit: "pts", fmt: (v) => v.toFixed(0), step: 10, log: true }));
    const trailWarn = el("div", { class: "error-text",
      text: "Long trails or many bodies at once can lower the frame rate.",
      style: "display:none" });
    this.add({ root: trailWarn, refresh: () => {
      const moving = app.world.bodies.reduce((n, b) => n + (b.locked ? 0 : 1), 0);
      const heavy = view.trails &&
        (view.trailLen >= 1500 || moving >= 40 || view.trailLen * moving >= 30000);
      trailWarn.style.display = heavy ? "" : "none";
    } });
    chk("Centre of mass", () => view.com, (v) => { view.com = v; });
    chk("Contact normals", () => view.contacts, (v) => { view.contacts = v; },
        "Arrow at every collision this frame");
    chk("Broadphase grid", () => view.spatialGrid, (v) => { view.spatialGrid = v; },
        "Spatial-hash cells used by the collision engine (G)");

    this.body.append(section("Graph dock"));
    this.add(segmented(["Off", "Energy", "Mom.", "Phase"], () => app.graphMode,
      (v) => app.setGraphMode(v as GraphMode),
      "Live plots along the bottom of the screen (keys 1, 2, 3)"));
  }
}
