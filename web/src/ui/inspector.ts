/** Inspector: tabbed side panel editing the selection, world and view.
 *
 * Rebuilt whenever the selection structure changes; while the structure is
 * stable, controls refresh in place every frame so live values (positions,
 * velocities) stay current without stealing focus.
 */
import { App, GraphMode, Panel } from "../app";
import { BODY_PALETTE, Body, Color, MATERIALS, Wall } from "../engine/body";
import { DistanceLink, SpringLink } from "../engine/links";
import { Driver, ForceField, INTEGRATORS, Integrator } from "../engine/world";
import { Selectable } from "../render/draw";
import { isMathRenderable } from "../core/mathfmt";
import { INSPECTOR_W_MAX, INSPECTOR_W_MIN, PHONE_QUERY, RefreshGroup, button,
         checkbox, colourEdit, el, fmt3dp, halfRow, isPhone, isTouch, numEdit,
         onMediaChange, section, segmented, slider, splitterDrag,
         textEdit } from "./dom";
import { ICONS } from "./icons";
import { mathEdit } from "./mathedit";
import { overlayToggles } from "./panels";

/** A saved width, held to the same bounds the splitter enforces. */
function clampInspectorW(w: number): number {
  return Math.max(INSPECTOR_W_MIN, Math.min(INSPECTOR_W_MAX, w));
}

/** One selected object's identity, for the key that decides whether the
 * panel needs rebuilding.
 *
 * Ids restart at 1 for each kind, so body 3 and wall 3 must not produce the
 * same entry - the kind has to be part of it. That used to come from
 * `constructor.name`, which worked only by luck: the production build
 * minifies class names, so the key was built from whatever one-character
 * name the bundler happened to assign. It stays consistent within a build,
 * which is why nothing broke, but it is the bundler deciding a correctness
 * property rather than us - and it fails silently, as a panel that does not
 * rebuild when the selection changes, if two classes ever land on the same
 * name. An explicit tag costs nothing and cannot be minified away.
 */
function selectionKey(o: Selectable): string {
  const kind = o instanceof Body ? "b"
    : o instanceof Wall ? "w"
      : o instanceof SpringLink ? "s" : "r";
  return `${kind}${o.id}`;
}

const TABS = ["Selection", "World", "View"] as const;
type Tab = (typeof TABS)[number];

/** The "performance mode is on" banner above the Solver controls: why they
 * are greyed out, and the single click that gives them back. Present only
 * while the mode is on.
 *
 * Deliberately not accent-coloured. The accent is the app's "this is
 * yours/this is active" colour and it is user-configurable, so a banner
 * wearing it would read as one more highlighted control rather than as the
 * app telling you it has taken the controls away. It uses the semantic
 * warning colour instead - the same one the "can't keep up" notice uses - and
 * leans on a filled pill, a tinted block and a left bar so the signal survives
 * whatever accent the user has picked, colourblindness included.
 */
function perfModeBanner(app: App): { root: HTMLElement; refresh: () => void } {
  const off = button("Turn off performance mode", () => app.setPerfMode(false),
    { tooltip: "Switch performance mode off, restoring this scene's own " +
               "solver settings and full accuracy." });
  off.root.classList.add("perf-banner-btn");
  const root = el("div", { class: "perf-banner" },
    el("span", { class: "perf-badge", text: "Performance mode is on" }),
    el("span", { class: "perf-banner-text",
                 text: "The solver settings below are disabled and are not " +
                       "what is running." }),
    off.root);
  return { root, refresh: () => { root.hidden = !app.perfMode; } };
}

export class Inspector implements Panel {
  private app: App;
  private root: HTMLElement;
  private body: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = "Selection";
  private group = new RefreshGroup();
  private structureKey = "";
  /** Formula rows where the user chose plain text over typeset math.
   *
   * Keyed by "<field row>:<component>", NOT by ForceField identity. Undo
   * and redo rebuild the whole world from a snapshot, so every ForceField
   * is a fresh object afterwards - an identity-keyed WeakMap silently
   * forgot the choice on any undo, dropping the user back into the typeset
   * editor they had just left. The row index is what survives, and it is
   * also what the user is actually pointing at. */
  private preferTextFormula = new Set<string>();
  private collapsed = false;
  private splitter: HTMLElement;
  private reopenStrip: HTMLElement;
  private handle: HTMLElement;

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;

    // slim clickable strip shown while the panel is collapsed
    this.reopenStrip = el("div", { class: "reopen-strip",
                                   title: "Show the panel (\\)" });
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
                                       title: "Hide the panel (\\)" });
    collapseBtn.insertAdjacentHTML("beforeend", ICONS.chev_right);
    collapseBtn.addEventListener("click", () => this.toggleCollapsed());
    tabs.append(collapseBtn);
    this.body = el("div", { class: "inspector-body" });
    // long panels (many drivers/fields) only refresh the controls that
    // are actually scrolled into view
    this.group.cullWithin(this.body);
    root.append(tabs, this.body);

    // width splitter (persisted)
    const saved = app.settings.inspector_w;
    if (typeof saved === "number") root.style.width = `${clampInspectorW(saved)}px`;
    splitterDrag(splitter, (e) => {
      const w = Math.max(INSPECTOR_W_MIN,
                         Math.min(INSPECTOR_W_MAX, window.innerWidth - e.clientX));
      root.style.width = `${w}px`;
      app.resizeCanvas();
    }, () => {
      app.settings.inspector_w = root.clientWidth;
      app.saveSettings();
    });

    app.onSelectionChange = () => {
      if (this.tab === "Selection") this.markDirty();
      else this.refreshStructure();
    };
    app.onWorldReplaced = () => this.markDirty();

    // Phones: the panel becomes a slide-over drawer. It starts closed, and
    // a fixed handle on the right screen edge opens it - without one there
    // is no way in at all (no keyboard, and the desktop reopen strip lives
    // inside the hidden panel).
    this.handle = el("div", { id: "inspector-handle", title: "Open the panel" });
    this.handle.insertAdjacentHTML("beforeend", ICONS.chev_left);
    this.handle.addEventListener("click", () => this.toggleCollapsed());
    document.body.append(this.handle);
    if (isPhone()) this.collapsed = true;
    this.applyCollapsed();
    // re-apply when the viewport crosses the phone breakpoint (media-change
    // AND resize: some webviews throttle one or the other)
    let wasPhone = isPhone();
    const onViewportChange = () => {
      if (isPhone() === wasPhone) return;
      wasPhone = !wasPhone;
      this.applyCollapsed();
    };
    onMediaChange(PHONE_QUERY, onViewportChange);
    window.addEventListener("resize", onViewportChange);

    this.rebuild();
  }

  /** Reflect the collapsed state in the DOM for the current viewport. */
  private applyCollapsed(): void {
    const phone = isPhone();
    this.root.classList.toggle("collapsed", this.collapsed);
    this.root.classList.toggle("mobile-open", !this.collapsed && phone);
    this.body.hidden = this.collapsed;
    (this.root.querySelector(".tabs") as HTMLElement).hidden = this.collapsed;
    this.reopenStrip.hidden = !this.collapsed;
    this.splitter.hidden = this.collapsed || phone; // no resizing drawers
    if (this.collapsed || phone) {
      // let .collapsed / the drawer CSS set the width
      this.root.style.removeProperty("width");
    } else if (typeof this.app.settings.inspector_w === "number") {
      this.root.style.width = `${clampInspectorW(this.app.settings.inspector_w)}px`;
    }
    this.handle.hidden = !phone || !this.collapsed;
    this.app.resizeCanvas();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.applyCollapsed();
    if (this.collapsed && !isPhone()) {
      this.app.toast("Panel hidden - press \\ or click the right edge to reopen");
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
               `${app.world.mutualGravity}:` +
               app.world.fields.map((f) => f.error).join("|");
      }
      return this.tab;
    }
    const sel = app.selection;
    const ids = sel.map(selectionKey).join(",");
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
    this.target = this.body;
    for (const [t, b] of this.tabBtns) b.classList.toggle("active", t === this.tab);
    if (this.tab === "Selection") this.buildSelection();
    else if (this.tab === "World") this.buildWorld();
    else this.buildView();
    this.group.refreshAll();
  }

  /** Where `add` and friends currently append.
   *
   * Normally the panel body; inside a multi-selection it is the card for
   * the object type being described, so a group's controls are visibly
   * contained by it rather than running together into the next group.
   * Assigned by rebuild(), which the constructor calls. */
  private target!: HTMLElement;

  private add(c: { root: HTMLElement; refresh?: () => void }): void {
    this.target.append(this.group.add(c).root);
  }

  private addHalf(a: { root: HTMLElement; refresh?: () => void },
                  b: { root: HTMLElement; refresh?: () => void }): void {
    this.group.add(a);
    this.group.add(b);
    this.target.append(halfRow(a.root, b.root));
  }

  /** A sub-heading (Material, Constant force) inside whatever is current. */
  private sub(title: string): void {
    this.target.append(section(title));
  }

  /** Open a card for one object type in a multi-selection, and make it the
   * append target until the next `typeGroup` or `endGroups`. */
  private typeGroup(title: string, count: number, kind: string): void {
    const head = el("div", { class: "type-head" },
      el("span", { class: "type-name", text: title }),
      el("span", { class: "type-count", text: String(count) }));
    this.target = el("div", { class: `type-group type-${kind}` }, head);
    this.body.append(this.target);
  }

  private endGroups(): void {
    this.target = this.body;
  }

  // -------------------------------------------------------------- selection
  private buildSelection(): void {
    const app = this.app;
    const sel = app.selection;
    if (sel.length === 0) {
      const lines = isTouch()
        ? ["Nothing selected.", "",
           "Tap an object with the Select tool,",
           "or drag a box around several objects."]
        : ["Nothing selected.", "",
           "Click an object with the Select tool,",
           "or drag a box around several objects.",
           "Shift-click adds to the selection."];
      for (const line of lines) {
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
        // One heading for both contexts: with nothing selected these buttons
        // clear the whole scene by type, and inside a multi-selection they
        // narrow the selection by type. "every" and "only" tried to name
        // that difference and only made the two panels look unrelated - the
        // buttons already say what they delete and how many.
        this.body.append(section("Delete ..."));
        for (const [grp, lbl] of nonEmpty) {
          this.add(button(`All ${lbl} (${grp.length})`,
            () => this.deleteObjs([...grp], lbl),
            { style: "danger",
              tooltip: `Remove every ${lbl} in the scene. Ctrl+Z restores them.` }));
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
    }, "name", "Name"));
  }

  private buildSingleBody(b: Body): void {
    const app = this.app;
    this.nameEdit(b);
    this.add(slider("Mass", () => b.mass, (v) => { b.mass = v; },
      0.001, 10000.0, { unit: "kg", log: true, onCommit: this.commit,
        tooltip: "Mass of the body, both inertial and gravitational." }));
    this.add(slider("Radius", () => b.radius, (v) => { b.radius = v; },
      0.01, 10.0, { unit: "m", log: true, onCommit: this.commit,
        tooltip: "Size of the body. Mass is set separately." }));
    this.addHalf(
      numEdit("x", () => b.pos.x, (v) => { b.pos.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y", () => b.pos.y, (v) => { b.pos.y = v; }, "m", this.commit, fmt3dp));
    this.addHalf(
      numEdit("vx", () => b.vel.x, (v) => { b.vel.x = v; }, "", this.commit, fmt3dp),
      numEdit("vy", () => b.vel.y, (v) => { b.vel.y = v; }, "", this.commit, fmt3dp));
    this.add(slider("Spin", () => b.omega, (v) => { b.omega = v; },
      -100.0, 100.0, { unit: "rad/s", fmt: (v) => v.toFixed(2), onCommit: this.commit,
        disabled: () => b.noRotation,
        tooltip: "Rate the body spins about its own centre. Unavailable " +
                 "while No rotation is on." }));
    this.addHalf(
      checkbox("Locked", () => b.locked, (v) => { b.locked = v; this.commit(); },
        "Hold the body permanently in place, as a pivot or obstacle (K)."),
      checkbox("Collides", () => b.collides, (v) => { b.collides = v; this.commit(); },
        "Let the body collide. Off, it passes through everything."));
    this.add(checkbox("No rotation", () => b.noRotation,
      (v) => { b.noRotation = v; if (v) b.omega = 0.0; this.commit(); },
      "Stop the body spinning, so it behaves as a point particle. Friction " +
      "can then hold it still on a slope instead of rolling it down."));

    this.sub("Material");
    this.add(slider("Bounce", () => b.restitution, (v) => { b.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Fraction of approach speed kept after an impact. " +
                 "1 = perfectly elastic, 0 = no bounce at all." }));
    this.add(slider("Friction", () => b.friction, (v) => { b.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Resistance to sliding at contact. 0 = frictionless." }));
    this.materialButtons([b]);
    this.colourRow([b]);

    this.sub("Constant force");
    this.addHalf(
      numEdit("Fx", () => b.constForce.x, (v) => { b.constForce.x = v; }, "N", this.commit),
      numEdit("Fy", () => b.constForce.y, (v) => { b.constForce.y = v; }, "N", this.commit));

    const drv = this.app.world.drivers.find((d) => d.bodyId === b.id);
    this.sub("Driving force");
    if (drv === undefined) {
      this.add(button("Add sinusoidal driver", () => {
        app.world.drivers.push(new Driver(b.id));
        app.pushUndo();
        this.markDirty();
      }, { icon: ICONS.plus,
           tooltip: "Apply an oscillating force F = A sin(2 pi f t) to this " +
                    "body." }));
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
        tooltip: "Size of the anchor." }));
    this.addHalf(
      numEdit("x", () => b.pos.x, (v) => { b.pos.x = v; }, "m", this.commit, fmt3dp),
      numEdit("y", () => b.pos.y, (v) => { b.pos.y = v; }, "m", this.commit, fmt3dp));
    this.add(checkbox("Collides", () => b.collides, (v) => { b.collides = v; this.commit(); },
      "Let bodies collide with this anchor. Off, they pass through it."));

    this.sub("Material");
    this.add(slider("Bounce", () => b.restitution, (v) => { b.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Fraction of approach speed a body keeps after hitting " +
                 "this anchor. 1 = perfectly elastic, 0 = no bounce at all." }));
    this.add(slider("Friction", () => b.friction, (v) => { b.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Resistance to sliding against this anchor. " +
                 "0 = frictionless." }));
    this.materialButtons([b]);
    this.colourRow([b]);

    this.actionButtons();
  }

  /** Colour editor writing to every object passed in.
   *
   * Colours are per-object and saved with the scene, so this is the one
   * place they can be set - the accent picker in Settings is UI chrome only
   * and deliberately never touches them. Each object gets its OWN array:
   * bodies used to be handed a reference into BODY_PALETTE, so writing
   * through it would have recoloured every body sharing that palette slot. */
  private colourRow(objs: Array<{ color: Color }>, label = "Colour"): void {
    this.add(colourEdit(label, () => objs[0].color,
      (c) => { for (const o of objs) o.color = [...c]; },
      { presets: BODY_PALETTE, onCommit: this.commit,
        tooltip: objs.length > 1
          ? "Drawing colour for every selected object. Saved with the scene."
          : "Drawing colour, saved with the scene. The swatches below are " +
            "the palette new bodies are picked from." }));
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
      }, { tooltip: `Set bounce to ${e} and friction to ${mu}.` });
      grid.append(b.root);
    }
    this.target.append(grid);
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
      this.typeGroup("Bodies", bodies.length, "body");
      this.add(slider("Mass", () => first.mass,
        (v) => bodies.forEach((b) => { b.mass = v; }), 0.001, 10000.0,
        { unit: "kg", log: true, onCommit: this.commit }));
      this.add(slider("Radius", () => first.radius,
        (v) => bodies.forEach((b) => { b.radius = v; }), 0.01, 10.0,
        { unit: "m", log: true, onCommit: this.commit }));
      this.add(slider("Bounce", () => first.restitution,
        (v) => bodies.forEach((b) => { b.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Fraction of approach speed kept after an impact. " +
                   "1 = perfectly elastic, 0 = no bounce at all." }));
      this.add(slider("Friction", () => first.friction,
        (v) => bodies.forEach((b) => { b.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to sliding at contact. 0 = frictionless." }));
      this.materialButtons(bodies);
      this.colourRow(bodies);
      this.addHalf(
        checkbox("Locked", () => first.locked,
          (v) => { bodies.forEach((b) => { b.locked = v; }); this.commit(); },
          "Hold the bodies permanently in place, as pivots or obstacles (K)."),
        checkbox("Collides", () => first.collides,
          (v) => { bodies.forEach((b) => { b.collides = v; }); this.commit(); },
          "Let the bodies collide. Off, they pass through everything."));
      this.add(checkbox("No rotation", () => first.noRotation,
        (v) => { bodies.forEach((b) => { b.noRotation = v; if (v) b.omega = 0.0; });
                 this.commit(); },
        "Stop the bodies spinning, so each behaves as a point particle. " +
        "Friction can then hold them still on a slope instead of rolling."));
      this.sub("Constant force");
      this.addHalf(
        numEdit("Fx", () => first.constForce.x,
          (v) => bodies.forEach((b) => { b.constForce.x = v; }), "N", this.commit),
        numEdit("Fy", () => first.constForce.y,
          (v) => bodies.forEach((b) => { b.constForce.y = v; }), "N", this.commit));
      this.buildMultiDrivers(bodies);
      if (bodies.length >= 2) {
        this.sub("Align");
        const grid = el("div", { class: "btn-grid-4" });
        const items: Array<[string, string, () => void]> = [
          ["|x", "Align the bodies to the same x.", () => this.align(bodies, "x")],
          ["y—", "Align the bodies to the same y.", () => this.align(bodies, "y")],
          ["↔", "Space the bodies evenly in x.", () => this.distribute(bodies, "x")],
          ["↕", "Space the bodies evenly in y.", () => this.distribute(bodies, "y")],
        ];
        for (const [label, tip, fn] of items) {
          grid.append(button(label, fn, { tooltip: tip }).root);
        }
        this.target.append(grid);
      }
    }

    if (anchors.length > 0) {
      const af = anchors[0];
      this.typeGroup("Anchors", anchors.length, "anchor");
      this.add(slider("Radius", () => af.radius,
        (v) => anchors.forEach((a) => { a.radius = v; }), 0.01, 10.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Size of the anchors." }));
      this.add(slider("Bounce", () => af.restitution,
        (v) => anchors.forEach((a) => { a.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Fraction of approach speed a body keeps after hitting " +
                   "these anchors. 1 = perfectly elastic, 0 = no bounce." }));
      this.add(slider("Friction", () => af.friction,
        (v) => anchors.forEach((a) => { a.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to sliding against these anchors. " +
                   "0 = frictionless." }));
      this.materialButtons(anchors);
      this.colourRow(anchors);
      this.add(checkbox("Collides", () => af.collides,
        (v) => { anchors.forEach((a) => { a.collides = v; }); this.commit(); },
        "Let bodies collide with these anchors. Off, they pass through."));
    }

    if (walls.length > 0) {
      const wf = walls[0];
      this.typeGroup("Walls", walls.length, "wall");
      this.add(slider("Thickness", () => wf.thickness,
        (v) => walls.forEach((w) => { w.thickness = v; }), 0.01, 2.0,
        { unit: "m", log: true, fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.add(slider("Bounce", () => wf.restitution,
        (v) => walls.forEach((w) => { w.restitution = v; }), 0.0, 1.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.add(slider("Friction", () => wf.friction,
        (v) => walls.forEach((w) => { w.friction = v; }), 0.0, 10.0,
        { fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.colourRow(walls);
    }

    if (springs.length > 0) {
      const sf = springs[0];
      this.typeGroup("Springs & strings", springs.length, "spring");
      this.add(slider("Stiffness", () => sf.stiffness,
        (v) => springs.forEach((s) => { s.stiffness = v; }), 0.01, 100000.0,
        { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Force per metre of stretch, k in F = -k x." }));
      this.add(slider("Damping", () => sf.damping,
        (v) => springs.forEach((s) => { s.damping = v; }), 0.0, 500.0,
        { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to stretching and compressing, which bleeds " +
                   "energy out of the oscillation." }));
    }

    if (rods.length > 0) {
      const rf = rods[0];
      this.typeGroup("Rods", rods.length, "rod");
      this.add(slider("Length", () => rf.length,
        (v) => rods.forEach((r) => { r.length = v; }), 0.01, 100.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Fixed separation the rods hold between their bodies." }));
    }

    this.endGroups();
    this.actionButtons();
    // selective deletion: remove just one kind of thing from the selection
    const groups: Array<[Selectable[], string]> = [
      [bodies, "bodies"], [anchors, "anchors"], [walls, "walls"],
      [springs, "springs"], [rods, "rods"],
    ];
    const nonEmpty = groups.filter(([g]) => g.length > 0);
    if (nonEmpty.length >= 2) {
      this.body.append(section("Delete ..."));
      const grid = el("div", { class: "btn-grid-2" });
      for (const [grp, lbl] of nonEmpty) {
        grid.append(button(`${lbl[0].toUpperCase()}${lbl.slice(1)} (${grp.length})`,
          () => this.deleteObjs([...grp], lbl),
          { style: "danger",
            tooltip: `Delete only the selected ${lbl}, keeping the rest of the ` +
                     "selection." }).root);
      }
      this.body.append(grid);
    }
  }

  /** Edit the sinusoidal drivers of every selected body at once. */
  private buildMultiDrivers(bodies: Body[]): void {
    const app = this.app;
    const ids = new Set(bodies.map((b) => b.id));
    const drvs = app.world.drivers.filter((d) => ids.has(d.bodyId));
    this.sub(`Driving force (${drvs.length}/${bodies.length} driven)`);
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
        { icon: ICONS.plus,
          tooltip: "Apply an oscillating force F = A sin(2 pi f t) to every " +
                   "selected body." }));
      return;
    }
    this.driverControls(drvs);
    const grid = el("div", { class: "btn-grid-2" });
    if (drvs.length < bodies.length) {
      grid.append(button("Drive rest", addAll,
        { tooltip: "Add a driver to each selected body that has none." }).root);
    }
    grid.append(button("Remove all", () => {
      app.world.drivers = app.world.drivers.filter((d) => !drvs.includes(d));
      app.pushUndo();
      this.markDirty();
    }, { style: "danger",
         tooltip: "Remove the driver from every selected body." }).root);
    this.target.append(grid);
  }

  private deleteObjs(objs: Selectable[], label: string): void {
    // These buttons are the bulk path by definition ("Delete every body
    // (500)"), so they take the batched route rather than paying the
    // per-object world edit and reconciliation scan.
    this.app.controller.deleteObjects(objs);
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
    // Two bodies are already evenly spaced, so there is nothing to do - but
    // silently doing nothing reads as a broken button. Say so instead.
    if (bodies.length < 3) {
      this.app.toast("Select three or more bodies to space them evenly");
      return;
    }
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
      0.01, 2.0, { unit: "m", log: true, fmt: (v) => v.toFixed(2),
        onCommit: this.commit, tooltip: "Width of the wall across its length." }));
    this.body.append(section("Material"));
    this.add(slider("Bounce", () => w.restitution, (v) => { w.restitution = v; },
      0.0, 1.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Fraction of approach speed a body keeps after hitting " +
                 "this wall. 1 = perfectly elastic, 0 = no bounce at all." }));
    this.add(slider("Friction", () => w.friction, (v) => { w.friction = v; },
      0.0, 10.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Resistance to sliding along this wall. 0 = frictionless." }));
    this.colourRow([w]);
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
          tooltip: "Length at which it exerts no force." }));
      this.add(slider("Stiffness", () => link.stiffness, (v) => { link.stiffness = v; },
        0.01, 100000.0, { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Force per metre of stretch, k in F = -k x." }));
      this.add(slider("Damping", () => link.damping, (v) => { link.damping = v; },
        0.0, 500.0, { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to stretching and compressing, which bleeds " +
                   "energy out of the oscillation." }));
      if (isString) {
        this.add(checkbox("Inelastic (fixed length)", () => false,
          () => this.replaceLink(link,
            new DistanceLink(link.a, link.b, link.restLength, true)),
          "Make the string unstretchable: rigid at its natural length when " +
          "taut, still slack when shorter."));
      }
    } else {
      this.body.append(el("div", { text: link.isRope ? "String (inelastic)" : "Rod",
        style: "font-weight:600;margin-bottom:6px" }));
      this.add(slider("Nat. len", () => link.length, (v) => { link.length = v; },
        0.01, 100.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: link.isRope
            ? "Length at which it goes taut. Rigid when taut, free when slack."
            : "Fixed separation the rod holds between the two bodies." }));
      if (link.isRope) {
        this.add(checkbox("Inelastic (fixed length)", () => true,
          () => this.replaceLink(link,
            new SpringLink(link.a, link.b, link.length, 1000.0, 2.0, true)),
          "Untick to make the string elastic, so it stretches under load. " +
          "Adds stiffness and damping."));
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
      { tooltip: "Create a copy of the selection (Ctrl+D)." }).root);
    g1.append(button("Delete", () => app.controller.deleteSelection(),
      { style: "danger",
        tooltip: "Delete the selected objects (Del)." }).root);
    this.body.append(g1);
    const g2 = el("div", { class: "btn-grid-2" });
    g2.append(button("Copy props", () => app.copyProps(),
      { tooltip: "Copy this body's material and physical properties " +
                 "(Ctrl+C)." }).root);
    const paste = this.group.add(button("Paste props", () => app.pasteProps(),
      { isEnabled: () => app.clipboardProps !== null,
        tooltip: "Apply the copied properties to the selection (Ctrl+V)." }));
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
        tooltip: "Uniform downward gravity. 9.81 = Earth, 24.8 = Jupiter, " +
                 "0 = space, negative = upward." }));
    this.add(checkbox("Bodies attract each other", () => world.mutualGravity,
      (v) => { world.mutualGravity = v; this.commit(); this.markDirty(); },
      "Newtonian attraction between every pair of bodies, for orbits."));
    if (world.mutualGravity) {
      this.add(slider("G", () => world.G, (v) => { world.G = v; },
        0.0001, 100000.0, { log: true, onCommit: this.commit,
          tooltip: "Gravitational constant, in this scene's scaled units." }));
      this.add(slider("Softening", () => world.softening, (v) => { world.softening = v; },
        0.0001, 2.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Smooths the attraction at very small separations." }));
      this.add(checkbox("Point-mass gravity", () => world.pointGravity,
        (v) => { world.pointGravity = v; this.commit(); },
        "Recommended: Disabled. Concentrates each body's mass at its " +
        "centre, which lets overlapping bodies slingshot to extreme " +
        "speeds. Off, bodies attract as solid discs and the pull fades to " +
        "zero at the centre of an overlap, as in reality."));
    }

    this.body.append(section("Air & damping"));
    this.add(slider("Linear drag", () => world.dragLinear, (v) => { world.dragLinear = v; },
      0.0, 20.0, { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Viscous drag proportional to speed: F = -c v." }));
    this.add(slider("Quad. drag", () => world.dragQuadratic,
      (v) => { world.dragQuadratic = v; }, 0.0, 20.0,
      { fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Aerodynamic drag proportional to speed squared: " +
                 "F = -c |v| v." }));
    this.add(slider("Damping", () => world.globalDamping,
      (v) => { world.globalDamping = v; }, 0.0, 20.0,
      { unit: "1/s", fmt: (v) => v.toFixed(2), onCommit: this.commit,
        tooltip: "Exponential decay applied to every velocity, bleeding " +
                 "energy out of the whole scene." }));

    this.body.append(section("Solver"));
    // Performance mode overrides all three controls below without writing to
    // the scene. Leaving them live while they are being ignored is the one
    // thing this panel must not do, so they are disabled outright and the
    // banner says why and offers the way out in one click. The VALUES stay
    // the scene's own throughout - they are what a save writes, and they are
    // exactly what comes back the moment the mode is switched off.
    this.add(perfModeBanner(app));
    const perfOn = (): boolean => app.perfMode;
    const short: Record<Integrator, string> = {
      "Velocity Verlet": "Verlet", "Symplectic Euler": "Euler", RK4: "RK4",
    };
    const rev: Record<string, Integrator> = {};
    for (const i of INTEGRATORS) rev[short[i]] = i;
    this.add(segmented(Object.values(short), () => short[world.integrator],
      (v) => { world.integrator = rev[v]; this.commit(); },
      "Numerical method used to advance the simulation. Verlet: best " +
      "all-round, excellent long-term energy behaviour. Euler: fastest, " +
      "least accurate. RK4: most accurate over short spans, drifts on long " +
      "orbits.", perfOn));
    this.add(slider("Substeps", () => world.substeps,
      (v) => { world.substeps = Math.round(v); world.substepsCappedFrom = null; },
      1, 64,
      { fmt: (v) => v.toFixed(0), step: 1, log: true, onCommit: this.commit,
        disabled: perfOn,
        tooltip: "Physics substeps per 1/120 s step. Higher is more " +
                 "accurate and slower." }));
    // A preset whose substeps were cut to fit the cost ceiling shows a
    // smaller number than it was authored with, which looks like the scene
    // simply chose it. Say what happened and that it can be undone - the
    // note disappears as soon as the slider is touched.
    //
    // Not while performance mode is on: the banner has already said that
    // nothing here is in effect, and a second note explaining a number that
    // is not being used only competes with it.
    const capNote = el("div", { class: "faint settings-note" });
    this.add({ root: capNote, refresh: () => {
      const from = world.substepsCappedFrom;
      const show = from !== null && from > world.substeps && !app.perfMode;
      capNote.style.display = show ? "" : "none";
      const want = `Reduced from ${from} so this scene runs in real time ` +
                   "on a modest machine. Raise it if yours can afford it.";
      if (show && capNote.textContent !== want) capNote.textContent = want;
    } });
    this.add(slider("Iterations", () => world.iterations,
      (v) => { world.iterations = Math.round(v); }, 1, 64,
      { fmt: (v) => v.toFixed(0), step: 1, log: true, onCommit: this.commit,
        disabled: perfOn,
        tooltip: "Solver passes per substep for links and contacts. Higher " +
                 "is more stable in stacks and chains." }));
    // Adaptive resolution lives in Settings, not here: substeps and
    // iterations are properties of the SCENE and travel with it, while
    // adaptive resolution is a preference of this browser and does not.
    // Sitting in the same section, it read as if saving the scene would
    // carry it along.

    this.body.append(section("Custom force fields"));
    world.fields.forEach((field, fieldIndex) => {
      // enabled toggle + editable name on one row (the name is saved with
      // the scene, so it survives save/export like everything else)
      const nameRow = el("div", { class: "row" });
      const chk = this.group.add(checkbox("", () => field.enabled,
        (v) => { field.enabled = v; this.commit(); },
        "Apply this force field to the scene."));
      const nameEd = this.group.add(textEdit(() => field.name, (s) => {
        field.name = s.trim() || field.name;
        this.commit();
        return true;
      }, "Field name", "Force field name"));
      nameEd.root.style.flex = "1";
      nameRow.append(chk.root, nameEd.root);
      this.body.append(nameRow);
      for (const attr of ["fxSrc", "fySrc"] as const) {
        const row = el("div", { class: "num-row" });
        row.append(el("span", { class: "lbl", text: attr === "fxSrc" ? "Fx" : "Fy" }));
        const commitSrc = (s: string): boolean => {
          // keep the text either way so the user can fix it; a bad
          // expression just disables the field and shows the error
          field[attr] = s;
          const ok = field.compile();
          if (ok) app.pushUndo();
          this.markDirty();
          return ok;
        };
        // Formulas in the "clean" arithmetic subset get the typeset math
        // editor; if/else, logic, // and % have no math notation and stay
        // in the text editor. A per-row toggle lets the user opt out.
        const renderable = isMathRenderable(field[attr]);
        const prefKey = `${fieldIndex}:${attr}`;
        const useMath = renderable && !this.preferTextFormula.has(prefKey);
        const edit = this.group.add(useMath
          ? mathEdit(() => field[attr], commitSrc,
                     "Type math: ^ makes a power, / a fraction, sqrt a root",
                     `${attr === "fxSrc" ? "Fx" : "Fy"} formula`)
          : textEdit(() => field[attr], commitSrc, "e.g. -0.5*vx or -x*10",
                       `${attr === "fxSrc" ? "Fx" : "Fy"} formula`));
        const toggle = this.group.add(button("", () => {
          // leaving math prefers text, and vice versa
          if (useMath) this.preferTextFormula.add(prefKey);
          else this.preferTextFormula.delete(prefKey);
          this.markDirty();
        }, {
          icon: useMath ? ICONS.text_mode : ICONS.math_mode,
          style: "ghost",
          isEnabled: () => renderable || useMath,
          tooltip: useMath ? "Edit as plain text."
            : renderable ? "Edit as typeset math."
            : "Typeset editing handles plain arithmetic only. This formula " +
              "uses if/else, comparisons, logic, // or %.",
        }));
        row.append(edit.root, toggle.root);
        this.body.append(row);
      }
      if (field.error) {
        this.body.append(el("div", { class: "error-text", text: field.error }));
      }
      const remove = this.group.add(button("Remove field", () => {
        world.fields = world.fields.filter((f) => f !== field);
        this.commit();
        this.markDirty();
      }, { icon: ICONS.trash, style: "danger" }));
      // breathing room: the button sat flush against the Fy row above it
      remove.root.style.marginTop = "8px";
      this.body.append(remove.root);
    });
    const addBtn = this.group.add(button("Add force field", () => {
      world.fields.push(new ForceField(`Field ${world.fields.length + 1}`, "0", "0"));
      app.pushUndo();
      this.markDirty();
    }, { icon: ICONS.plus,
         tooltip: "Add a force in newtons applied to every body, written " +
                  "as a formula. Try Fy = -y*5 for a spring field." }));
    const guideBtn = this.group.add(button("Formula guide", () => {
      overlayToggles["formula-guide"]?.();
    }, { style: "ghost",
         tooltip: "Variables, functions and ready-made recipes for " +
                  "force-field formulas." }));
    this.body.append(el("div", { class: "field-actions" }, addBtn.root, guideBtn.root));

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

  // ------------------------------------------------------------------- view
  private buildView(): void {
    const app = this.app;
    const view = app.view;
    const chk = (label: string, get: () => boolean, set: (v: boolean) => void,
                 tip = "") => this.add(checkbox(label, get, set, tip));

    this.body.append(section("Canvas"));
    chk("Grid", () => view.grid, (v) => { view.grid = v; },
        "Show a scaled reference grid behind the scene.");
    chk("Snap to grid", () => view.snap, (v) => { view.snap = v; },
        "Align new and dragged objects to grid points (N).");
    chk("Body labels", () => view.labels, (v) => { view.labels = v; },
        "Show each body's name on the canvas.");
    chk("Follow selection", () => view.follow, (v) => { view.follow = v; },
        "Keep the camera centred on the selected body (C). Zoom-to-fit and " +
        "auto-fit are in the toolbar.");

    this.body.append(section("Vectors"));
    chk("Velocity vectors", () => view.velVectors, (v) => { view.velVectors = v; },
        "Green arrow showing each body's velocity (D). Drag the tip to set it.");
    chk("Acceleration vectors", () => view.accVectors, (v) => { view.accVectors = v; },
        "Orange arrow showing each body's acceleration.");
    chk("Net force vectors", () => view.forceVectors, (v) => { view.forceVectors = v; },
        "Red arrow showing the net force on each body, F = ma.");
    this.add(slider("Vector size", () => view.vectorScale,
      (v) => { view.vectorScale = v; }, 0.02, 20.0,
      { unit: "x", log: true, fmt: (v) => v.toFixed(2),
        tooltip: "Length multiplier for every vector arrow." }));

    this.body.append(section("Analysis"));
    this.add(checkbox("Motion trails", () => view.trails, (v) => app.setTrails(v),
      "Draw a fading path behind each moving body (T)."));
    this.add(slider("Trail length", () => view.trailLen,
      (v) => { view.trailLen = Math.round(v); }, 10, 10000,
      { unit: "pts", fmt: (v) => v.toFixed(0), step: 10, log: true,
        tooltip: "Points kept per trail, which sets how far back it reaches." }));
    const trailWarn = el("div", { class: "error-text",
      text: "Long trails or many bodies at once can lower the frame rate.",
      style: "display:none" });
    this.add({ root: trailWarn, refresh: () => {
      const moving = app.world.bodies.reduce((n, b) => n + (b.locked ? 0 : 1), 0);
      const heavy = view.trails &&
        (view.trailLen >= 1500 || moving >= 40 || view.trailLen * moving >= 30000);
      trailWarn.style.display = heavy ? "" : "none";
    } });
    chk("Centre of mass", () => view.com, (v) => { view.com = v; },
        "Mark the centre of mass of the whole scene.");
    chk("Contact normals", () => view.contacts, (v) => { view.contacts = v; },
        "Draw an arrow at every contact resolved this frame.");
    chk("Broadphase grid", () => view.spatialGrid, (v) => { view.spatialGrid = v; },
        "Show the cells collision detection uses to find candidate pairs (G).");

    this.body.append(section("Graph dock"));
    this.add(segmented(["Off", "Energy", "Mom.", "Phase"], () => app.graphMode,
      (v) => app.setGraphMode(v as GraphMode),
      "Live plot shown along the bottom of the screen (keys 1, 2, 3)."));
  }
}
