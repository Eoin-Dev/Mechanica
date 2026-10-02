/** Inspector: tabbed side panel editing the selection, world and view.
 *
 * Rebuilt whenever the selection structure changes; while the structure is
 * stable, controls refresh in place on the panel cadence so live values
 * (positions, velocities) stay current without stealing focus.
 */
import { App, GraphMode, Panel } from "../app";
import { BODY_PALETTE, Body, Color, MATERIALS, Wall } from "../engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../engine/links";
import { Driver, ForceField, INTEGRATORS, Integrator } from "../engine/world";
import { PlaybackEventKind, analysePulley, forceLedger, projectForce, touchingSlopeWall } from "../education/analysis";
import { forceSymbols } from "../engine/force-diagnostics";
import { analyseElasticLink, elasticModulus, stiffnessForModulus } from "../education/elasticity";
import { Selectable } from "../render/draw";
import { analysisNumber } from "../render/analysis-overlays";
import { isMathRenderable } from "../core/mathfmt";
import { INSPECTOR_W_MAX, INSPECTOR_W_MIN, PHONE_QUERY, RefreshGroup, button,
         checkbox, colourEdit, countNoun, el, fmt3dp, fmt3g, halfRow, isPhone, isTouch,
         numEdit, onMediaChange, pluralNoun, refreshTabs, section, segmented,
         slider, splitterDrag, textEdit, wireTabs } from "./dom";
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
      : o instanceof PulleyLink ? "p"
        : o instanceof SpringLink ? "s" : "r";
  return `${kind}${o.id}`;
}

const TABS = ["Selection", "World", "View"] as const;
type Tab = (typeof TABS)[number];
const RESTITUTION_HELP = "Coefficient of restitution e: relative separation speed divided by " +
  "relative approach speed along the contact normal. The lower of the two materials’ " +
  "values is used. e = 1 is elastic; e = 0 gives no relative normal rebound, " +
  "without joining the objects.";
const FRICTION_HELP = "Coefficient of friction μ. Contact uses √(μ₁ × μ₂) from the two " +
  "materials; either value at zero makes contact frictionless. Tangential friction " +
  "is limited by μ times the normal reaction and acts separately from restitution.";

/** A Performance-mode banner above controls the mode makes unavailable: why
 * they are greyed out, and the single click that gives them back. Present
 * only while the mode is on.
 *
 * Deliberately not accent-coloured. The accent is the app's "this is
 * yours/this is active" colour and it is user-configurable, so a banner
 * wearing it would read as one more highlighted control rather than as the
 * app telling you it has taken the controls away. It uses the semantic
 * warning colour instead - the same one the "can't keep up" notice uses - and
 * leans on a filled pill, a tinted block and a left bar so the signal survives
 * whatever accent the user has picked, colourblindness included.
 */
function perfModeBanner(app: App, message: string): { root: HTMLElement; refresh: () => void } {
  const off = button("Turn off performance mode", () => app.setPerfMode(false),
    { tooltip: "Switch performance mode off, restoring Normal-mode controls " +
               "and full accuracy." });
  off.root.classList.add("perf-banner-btn");
  const root = el("div", { class: "perf-banner" },
    el("span", { class: "perf-badge", text: "Performance mode is active" }),
    el("span", { class: "perf-banner-text", text: message }),
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
  private eventHistoryOpen = false;
  private forceValuesOpen = false;
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
  /** Desktop collapse is persisted; phone drawer visibility is deliberately
   * transient so opening/closing it never overwrites the desktop choice. */
  private desktopCollapsed: boolean;
  private phoneCollapsed = true;
  private splitter: HTMLElement;
  private reopenStrip: HTMLElement;
  private handle: HTMLElement;

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;
    this.desktopCollapsed = app.settings.inspector_visible === false;

    // Capture the live pre-edit state immediately before a control's target
    // listener mutates it. Range and colour inputs write continuously, while
    // text, numeric and math fields only write on change/blur; beginning on
    // their ordinary typing events would snapshot too early if physics keeps
    // evolving before the eventual commit. View-only controls do not touch
    // the world and deliberately stay out of history.
    const beginControlEdit = (event: Event): void => {
      if (this.tab === "View") return;
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest("input, math-field") ?? null;
      if (control === null) return;
      if (event.type === "input" &&
          !control.matches('input[type="range"], input[type="color"]')) {
        return;
      }
      app.beginEdit();
      if (event.type === "blur" || event.type === "change") {
        // Successful commits clear the boundary synchronously in the target
        // handler. Invalid, unchanged, or UI-only input has no commit, so
        // discard its speculative snapshot after event dispatch rather than
        // letting it absorb the next unrelated edit.
        queueMicrotask(() => app.cancelEdit());
      }
    };
    root.addEventListener("input", beginControlEdit, true);
    root.addEventListener("change", beginControlEdit, true);
    root.addEventListener("blur", beginControlEdit, true);
    root.addEventListener("click", (event) => {
      if (this.tab === "View") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || target.closest("button") === null) return;
      if (target.closest("[data-inspector-navigation]") !== null) return;
      app.beginEdit();
      // Mutation buttons synchronously commit in their own handler. A tab,
      // collapse or guide button does not; clear that speculative boundary
      // after bubbling so it cannot absorb a later unrelated edit.
      queueMicrotask(() => app.cancelEdit());
    }, true);

    // slim clickable strip shown while the panel is collapsed
    this.reopenStrip = el("button", { class: "reopen-strip",
                                      title: "Show the panel (\\)",
                                      "aria-label": "Show Inspector",
                                      "aria-controls": "inspector" });
    this.reopenStrip.insertAdjacentHTML("beforeend", ICONS.chev_left);
    this.reopenStrip.hidden = true;
    this.reopenStrip.addEventListener("click", () => this.toggleCollapsed());
    root.append(this.reopenStrip);

    const tabs = el("div", { class: "tabs" });
    const tabList = el("div", { class: "tab-list",
                                 "aria-label": "Inspector sections" });
    for (const t of TABS) {
      const id = `inspector-tab-${t.toLowerCase()}`;
      const b = el("button", { text: t, id, "aria-controls": "inspector-panel" });
      b.addEventListener("click", () => {
        this.tab = t;
        this.rebuild();
      });
      this.tabBtns.set(t, b);
      tabList.append(b);
    }
    wireTabs(tabList, this.tabBtns, (tab) => {
      this.tab = tab;
      this.rebuild();
    });
    const collapseBtn = el("button", { class: "collapse-btn",
                                       title: "Hide the panel (\\)",
                                       "aria-label": "Hide Inspector",
                                       "aria-controls": "inspector" });
    collapseBtn.insertAdjacentHTML("beforeend", ICONS.chev_right);
    collapseBtn.addEventListener("click", () => this.toggleCollapsed());
    tabs.append(tabList, collapseBtn);
    this.body = el("div", { class: "inspector-body", id: "inspector-panel",
                            role: "tabpanel", tabindex: "0" });
    // long panels (many drivers/fields) only refresh the controls that
    // are actually scrolled into view
    this.group.cullWithin(this.body);
    root.append(tabs, this.body);

    // width splitter (persisted)
    const saved = app.settings.inspector_w;
    if (typeof saved === "number") root.style.width = `${clampInspectorW(saved)}px`;
    const applyWidth = (w: number): void => {
      root.style.width = `${clampInspectorW(w)}px`;
      app.resizeCanvas();
    };
    splitterDrag(splitter, (e) => {
      const w = Math.max(INSPECTOR_W_MIN,
                         Math.min(INSPECTOR_W_MAX, window.innerWidth - e.clientX));
      applyWidth(w);
    }, () => {
      app.settings.inspector_w = root.getBoundingClientRect().width;
      app.saveSettings();
    }, {
      orientation: "vertical",
      label: "Resize Inspector",
      // Use the border-box width that applyWidth sets. clientWidth excludes
      // the panel border, so a requested 10 px keyboard step was announced
      // as 9 px and compounded that one-pixel loss on every key press.
      getValue: () => root.getBoundingClientRect().width,
      setValue: applyWidth,
      min: INSPECTOR_W_MIN,
      max: INSPECTOR_W_MAX,
      increaseKeys: ["ArrowLeft"],
      decreaseKeys: ["ArrowRight"],
    });

    // Commits also notify this callback. An ordinary value edit must not
    // detach the next field while the user is already typing into it.
    app.onSelectionChange = () => this.refreshStructure();
    app.onWorldReplaced = () => this.markDirty();

    // Phones: the panel becomes a slide-over drawer. It starts closed, and
    // a fixed handle on the right screen edge opens it - without one there
    // is no way in at all (no keyboard, and the desktop reopen strip lives
    // inside the hidden panel).
    this.handle = el("button", { id: "inspector-handle", title: "Open the panel",
                                  "aria-label": "Open Inspector",
                                  "aria-controls": "inspector" });
    this.handle.insertAdjacentHTML("beforeend", ICONS.chev_left);
    this.handle.addEventListener("click", () => this.toggleCollapsed());
    document.body.append(this.handle);
    this.applyCollapsed();
    // re-apply when the viewport crosses the phone breakpoint (media-change
    // AND resize: some webviews throttle one or the other)
    let wasPhone = isPhone();
    const onViewportChange = () => {
      const phone = isPhone();
      if (phone === wasPhone) return;
      wasPhone = phone;
      // Every entry into the phone layout is a fresh transient drawer
      // session. Its open state never becomes a hidden preference that can
      // surprise the user after a rotation or later resize.
      if (phone) this.phoneCollapsed = true;
      this.applyCollapsed();
    };
    onMediaChange(PHONE_QUERY, onViewportChange);
    window.addEventListener("resize", onViewportChange);

    this.rebuild();
  }

  /** Reflect the collapsed state in the DOM for the current viewport. */
  private applyCollapsed(): void {
    const phone = isPhone();
    const collapsed = phone ? this.phoneCollapsed : this.desktopCollapsed;
    this.root.classList.toggle("collapsed", collapsed);
    this.root.classList.toggle("mobile-open", !collapsed && phone);
    this.body.hidden = collapsed;
    (this.root.querySelector(".tabs") as HTMLElement).hidden = collapsed;
    this.reopenStrip.hidden = !collapsed || phone;
    this.splitter.hidden = collapsed || phone; // no resizing drawers
    if (collapsed || phone) {
      // let .collapsed / the drawer CSS set the width
      this.root.style.removeProperty("width");
    } else if (typeof this.app.settings.inspector_w === "number") {
      this.root.style.width = `${clampInspectorW(this.app.settings.inspector_w)}px`;
    }
    this.handle.hidden = !phone || !collapsed;
    this.reopenStrip.setAttribute("aria-expanded", String(!collapsed));
    this.handle.setAttribute("aria-expanded", String(!collapsed));
    const collapse = this.root.querySelector<HTMLButtonElement>(".collapse-btn");
    collapse?.setAttribute("aria-expanded", String(!collapsed));
    this.app.resizeCanvas();
  }

  toggleCollapsed(): void {
    if (isPhone()) {
      this.phoneCollapsed = !this.phoneCollapsed;
    } else {
      this.desktopCollapsed = !this.desktopCollapsed;
      this.app.settings.inspector_visible = !this.desktopCollapsed;
      this.app.saveSettings();
    }
    this.applyCollapsed();
    if (this.desktopCollapsed && !isPhone()) {
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
    // With no selection the panel exposes one bulk-delete button per nonempty
    // object kind, including its live count. A collection mutation can leave
    // selection unchanged, so its kind counts must participate in the key or
    // the Inspector can keep a stale "All bodies (N)" label indefinitely.
    let inventory = "";
    if (sel.length === 0) {
      let bodies = 0;
      let anchors = 0;
      let pulleys = 0;
      let springs = 0;
      let rods = 0;
      for (const body of app.world.bodies) {
        if (body.isRodEndpoint) continue;
        if (body.isPulley) pulleys++;
        else if (body.isAnchor) anchors++;
        else bodies++;
      }
      for (const link of app.world.links) {
        if (link instanceof PulleyLink) pulleys++;
        else if (link instanceof SpringLink) springs++;
        else rods++;
      }
      inventory = `:${bodies}:${anchors}:${app.world.walls.length}:` +
                  `${pulleys}:${springs}:${rods}`;
    }
    let pulleyMembership = "";
    let bodyRole = "";
    if (sel.length === 1 && sel[0] instanceof Body) {
      const body = sel[0];
      bodyRole = `${body.isAnchor}:${body.isPulley}:${body.isPivot}:${body.rodAttachmentId}`;
      pulleyMembership = app.world.links.filter((link) =>
        link instanceof PulleyLink &&
        (link.a === body || link.b === body || link.pulley === body))
        .map((link) => link.id).join(",");
    }
    return `sel:${ids}:${drivers}:w${app.world.walls.length}${inventory}:p${pulleyMembership}:${bodyRole}`;
  }

  private refreshStructure(): void {
    const key = this.computeStructureKey();
    if (key !== this.structureKey || this.dirty) {
      this.dirty = false;
      this.rebuild();
    }
  }

  refresh(): void {
    if (isPhone() ? this.phoneCollapsed : this.desktopCollapsed) return;
    this.refreshStructure();
    this.group.refreshAll();
  }

  private commit = (): void => {
    this.app.pushUndo();
  };

  // ------------------------------------------------------------------ build
  private rebuild(): void {
    // Read synchronously: a rewind can replace the node before its queued
    // native toggle event delivers the user's latest choice.
    const forceValues = this.body.querySelector<HTMLDetailsElement>(".force-values");
    if (forceValues !== null) this.forceValuesOpen = forceValues.open;
    this.structureKey = this.computeStructureKey();
    this.group.clear();
    this.body.replaceChildren();
    this.target = this.body;
    refreshTabs(this.tabBtns, this.tab, this.body);
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
        ["bodies", "Bodies / particles"], ["anchors", "Anchors"],
        ["pulleys", "Pulleys"], ["walls", "Walls"],
        ["springs", "Springs & strings"], ["rods", "Rods"],
      ];
      for (const [key, label] of rows) {
        this.add(checkbox(label, () => flt[key], (v) => { flt[key] = v; },
          "Object types included when you drag a selection box"));
      }
      const world = app.world;
      const groups: Array<[Selectable[], string, string]> = [
        [world.bodies.filter((b) => !b.isAnchor && !b.isRodEndpoint), "body", "bodies"],
        [world.bodies.filter((b) => b.isAnchor && !b.isPulley), "anchor", "anchors"],
        [world.bodies.filter((b) => b.isPulley), "pulley", "pulleys"],
        [world.walls, "wall", "walls"],
        [world.links.filter((l) => l instanceof SpringLink), "spring/string", "springs & strings"],
        [world.links.filter((l) => l instanceof DistanceLink), "rod", "rods"],
        [world.links.filter((l) => l instanceof PulleyLink), "pulley string", "pulley strings"],
      ];
      const nonEmpty = groups.filter(([g]) => g.length > 0);
      if (nonEmpty.length > 0) {
        // One heading for both contexts: with nothing selected these buttons
        // clear the whole scene by type, and inside a multi-selection they
        // narrow the selection by type. "every" and "only" tried to name
        // that difference and only made the two panels look unrelated - the
        // buttons already say what they delete and how many.
        this.body.append(section("Delete ..."));
        for (const [grp, singular, plural] of nonEmpty) {
          const counted = countNoun(grp.length, singular, plural);
          this.add(button(grp.length === 1 ? `Delete ${counted}` : `Delete all ${counted}`,
            () => this.deleteObjs([...grp], singular, plural),
            { style: "danger",
              tooltip: `Remove ${counted} from the scene. Ctrl+Z restores ` +
                       `${grp.length === 1 ? "it" : "them"}.` }));
        }
      }
      return;
    }
    let selectedPulley: PulleyLink | null = null;
    if (sel.length === 1) {
      const selected = sel[0];
      for (const link of app.world.links) {
        if (link instanceof PulleyLink &&
            (link === selected || link.a === selected || link.b === selected || link.pulley === selected)) {
          this.buildPulleyAssembly(link);
          selectedPulley = link;
        }
      }
    }
    const objectStart = this.body.childElementCount;
    if (sel.length === 1 && sel[0] instanceof Body) {
      if (sel[0].isPulley) this.buildSinglePulley();
      else if (sel[0].isPivot) this.buildSinglePivot(sel[0]);
      else if (sel[0].isAnchor) this.buildSingleAnchor(sel[0]);
      else this.buildSingleBody(sel[0]);
    } else if (sel.length === 1 && sel[0] instanceof Wall) this.buildWall(sel[0]);
    else if (sel.length === 1) {
      this.buildLink(sel[0] as DistanceLink | SpringLink | PulleyLink);
    }
    else this.buildMulti(sel);
    const particle = sel[0];
    if (selectedPulley && sel.length === 1 && particle instanceof Body &&
        (particle === selectedPulley.a || particle === selectedPulley.b)) {
      const part = particle === selectedPulley.a ? "Particle A" : "Particle B";
      const cue = el("span", { class: "inspector-particle-cue", "aria-hidden": "true" });
      const head = el("div", { class: "inspector-object-head" }, cue, el("h3", { text: part }));
      const card = el("div", { class: "inspector-object-card", role: "group",
        "aria-label": `${part} properties` }, head, ...[...this.body.children].slice(objectStart));
      this.body.append(card);
      this.group.add({ root: head, refresh: () => {
        const colour = `rgb(${particle.color.join(", ")})`;
        if (cue.style.backgroundColor !== colour) cue.style.backgroundColor = colour;
      } });
    }
  }

  private nameEdit(obj: { name: string }): void {
    this.add(textEdit(() => obj.name, (s) => {
      obj.name = s.trim() || obj.name;
      this.commit();
      return true;
    }, "name", "Name", 200));
  }

  private buildSingleBody(b: Body): void {
    const app = this.app;
    this.nameEdit(b);
    this.add(slider("Mass", () => b.mass, (v) => { b.mass = v; },
      0.001, 10000.0, { unit: "kg", log: true, onCommit: this.commit,
        tooltip: "Mass of the body, both inertial and gravitational." }));
    if (!app.world.isPulleyParticle(b)) {
      this.add(slider("Radius", () => b.radius, (v) => { b.radius = v; },
        0.01, 10.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Size of the body. Mass is set separately." }));
    }
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
        "Hold the body permanently in place as a fixed point or obstacle (K)."),
      checkbox("Collides", () => b.collides, (v) => { b.collides = v; this.commit(); },
        "Let the body collide. Off, it passes through everything."));
    this.add(checkbox("No rotation", () => b.noRotation,
      (v) => { b.noRotation = v; if (v) b.omega = 0.0; this.commit(); },
      "Stop the body spinning, so it behaves as a point particle. Friction " +
      "can then hold it still on a slope instead of rolling it down."));

    this.sub("Material");
    this.materialControls([b]);

    this.materialButtons([b]);
    this.colourRow([b]);

    this.sub("Constant force");
    this.addHalf(
      numEdit("Fx", () => b.constForce.x, (v) => { b.constForce.x = v; }, "N", this.commit),
      numEdit("Fy", () => b.constForce.y, (v) => { b.constForce.y = v; }, "N", this.commit));

    this.buildParticleAnalysis(b);
    this.buildRodAttachment(b);

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

  /** Free-body controls belong to the selected particle and draw directly on
   * the canvas rather than duplicating live kinematics in a bulky side card. */
  private buildParticleAnalysis(b: Body): void {
    const app = this.app;
    this.sub("Forces on canvas");
    this.add(checkbox("Free-body forces on canvas", () => b.showForceComponents,
      (value) => { b.showForceComponents = value; app.invalidateCanvas(); },
      "Draw current forces immediately. After a step, arrows share the resultant's time interval. R: reaction; F: friction; f: applied force; C: numerical correction."));

    const readout = el("details", { class: "force-values" },
      el("summary", { text: "Force values and sources" }));
    readout.open = this.forceValuesOpen;
    const values = el("ul", { class: "force-value-list", "aria-label": "Force values and sources" });
    readout.append(values);
    const rows = new Map<string, { root: HTMLElement; name: HTMLElement; components: HTMLElement }>();
    let rowKey = "";
    readout.addEventListener("toggle", () => {
      if (!readout.isConnected) return;
      this.forceValuesOpen = readout.open;
      this.refresh();
    });
    const forceNote = el("div", { class: "faint settings-note force-interval-note",
      title: "Current forces are calculated on isolated scene inputs. Contact and impact forces are estimated over one nominal solver interval; a completed step shows its measured average. Current previews use the authored model, including forces suppressed by Performance approximations." });
    // The disclosure may remain visible after its note scrolls away. Observe
    // their combined box so visible scientific values never stop refreshing.
    const forceReadout = el("div", { class: "force-readout" }, forceNote, readout);
    this.add({ root: forceReadout, refresh: () => {
      forceNote.hidden = !b.showForceComponents;
      readout.hidden = forceNote.hidden;
      forceReadout.hidden = forceNote.hidden;
      if (forceNote.hidden) return;
      const wall = b.forceSlopeWallId === null ? null :
        app.world.walls.find(candidate => candidate.id === b.forceSlopeWallId) ?? null;
      const ledger = forceLedger(app.world, b, wall);
      const text = ledger.mode === "step-average" && ledger.interval !== null ?
        `Average forces: ${fmt3dp(ledger.interval.start)}–${fmt3dp(ledger.interval.end)} s. R: reaction; F: friction; f: applied force; C: numerical correction.` :
        ledger.mode === "resting" ? "Resting forces: weight and support balance." :
          "Current forces. R: reaction; F: friction; f: applied force; C: numerical correction.";
      if (forceNote.textContent !== text) forceNote.textContent = text;
      if (!readout.open) return;
      const entries = [...ledger.entries, { id: "resultant", label: "Resultant",
        fx: ledger.resultant.fx, fy: ledger.resultant.fy }];
      const symbols = forceSymbols(ledger.entries);
      const key = entries.map(entry => entry.id).join(",");
      for (const entry of entries) {
        let row = rows.get(entry.id);
        if (row === undefined) {
          const name = el("span", { class: "force-value-name" });
          const components = el("span", { class: "force-value-components" });
          const root = el("li", { class: entry.id === "resultant" ? "force-resultant" : "" }, name, components);
          row = { root, name, components };
          rows.set(entry.id, row);
        }
        const symbol = symbols.get(entry.id);
        const name = symbol === undefined ? entry.label : `${symbol}: ${entry.label}`;
        if (row.name.textContent !== name) row.name.textContent = name;
        const text = [`Fx ${analysisNumber(entry.fx)} N`, `Fy ${analysisNumber(entry.fy)} N`];
        if (ledger.basis !== null) {
          const resolved = projectForce(entry, ledger.basis);
          text.push(`∥ ${analysisNumber(resolved.parallel)} N`, `⊥ ${analysisNumber(resolved.normal)} N`);
        }
        for (let i = 0; i < text.length; i++) {
          let component = row.components.children[i] as HTMLElement | undefined;
          if (component === undefined) {
            component = el("span", { class: "force-component" });
            row.components.append(component);
          }
          if (component.textContent !== text[i]) component.textContent = text[i];
        }
        while (row.components.children.length > text.length) row.components.lastElementChild!.remove();
      }
      if (key !== rowKey) {
        const live = new Set(entries.map(entry => entry.id));
        for (const id of rows.keys()) if (!live.has(id)) rows.delete(id);
        values.replaceChildren(...entries.map(entry => rows.get(entry.id)!.root));
        rowKey = key;
      }
    } });

    const slope = el("select", { "aria-label": "Resolve forces relative to a slope" });
    slope.addEventListener("change", () => {
      const wall = app.world.walls.find(wall => String(wall.id) === slope.value && touchingSlopeWall(b, wall));
      b.forceSlopeWallId = wall?.id ?? null;
      if (b.forceSlopeWallId !== null) b.showForceComponents = true;
      app.invalidateCanvas();
    });
    const slopeHelp = "Resolve the resultant along and normal to a wall in contact.";
    const slopeRow = el("div", { class: "row", role: "group", "aria-label": "Slope reference" },
      el("span", { class: "lbl", text: "Slope reference" }), slope);
    let slopeOptionsKey = "";
    this.add({ root: slopeRow, refresh: () => {
      const walls = app.world.walls.filter(wall => touchingSlopeWall(b, wall));
      const key = JSON.stringify(walls.map(wall => [wall.id, wall.name]));
      if (key !== slopeOptionsKey) {
        slope.replaceChildren(el("option", { value: "",
          text: walls.length === 0 ? "No slope in contact" : "No slope selected" }),
          ...walls.map(wall => el("option", { value: String(wall.id), text: wall.name })));
        slopeOptionsKey = key;
      }
      if (b.forceSlopeWallId !== null && !walls.some(wall => wall.id === b.forceSlopeWallId)) {
        b.forceSlopeWallId = null;
        app.invalidateCanvas();
      }
      const disabled = walls.length === 0;
      if (slope.disabled !== disabled) slope.disabled = disabled;
      slopeRow.classList.toggle("disabled", disabled);
      const disabledState = String(disabled);
      if (slopeRow.getAttribute("aria-disabled") !== disabledState) slopeRow.setAttribute("aria-disabled", disabledState);
      const help = disabled ? "No slope in contact." : slopeHelp;
      if (slopeRow.title !== help) slopeRow.title = help;
      if (slope.title !== help) slope.title = help;
      if (slope.getAttribute("aria-description") !== help) slope.setAttribute("aria-description", help);
      const value = b.forceSlopeWallId === null ? "" : String(b.forceSlopeWallId);
      if (slope.value !== value) slope.value = value;
    } });
  }

  private buildRodAttachment(b: Body): void {
    if (b.rodAttachmentId === null) return;
    const rod = this.app.world.links.find((link) =>
      link instanceof DistanceLink && !link.isRope && link.id === b.rodAttachmentId);
    if (!(rod instanceof DistanceLink)) return;
    this.sub("Rod attachment");
    const distance = (): number => (rod.originAtA ? b.rodAttachmentT : 1 - b.rodAttachmentT) * rod.length;
    const input = textEdit(() => distance().toFixed(3), (source) => {
      const value = Number(source);
      if (!Number.isFinite(value) || value < 0 || value > rod.length ||
          rod.length <= 1e-12) {
        this.app.toast(`Distance must be between 0 and ${rod.length.toFixed(3)} m`);
        return false;
      }
      b.rodAttachmentT = rod.originAtA ? value / rod.length : 1 - value / rod.length;
      const x = rod.a.pos.x + b.rodAttachmentT * (rod.b.pos.x - rod.a.pos.x);
      const y = rod.a.pos.y + b.rodAttachmentT * (rod.b.pos.y - rod.a.pos.y);
      b.pos.set(x, y);
      this.commit();
      this.app.invalidateCanvas();
      return true;
    }, "distance", "Position along rod");
    this.add({ root: el("div", { class: "row" },
      el("span", { class: "lbl", text: `From ${rod.originAtA ? "A" : "B"}` }),
      input.root, el("span", { class: "unit", text: "m" })), refresh: input.refresh });
    if (!b.isPivot) {
      this.add(button("Detach from rod", () => {
        b.rodAttachmentId = null;
        this.commit();
        this.markDirty();
      }, { tooltip: "Release this particle; its forces and links remain attached to the particle." }));
    }
  }

  private buildSinglePivot(b: Body): void {
    this.body.append(el("div", { text: "Rod anchor",
      style: "font-weight:600;margin-bottom:6px" }));
    this.body.append(el("div", { class: "dim", text:
      "An anchor attached to a point on the rod. It fixes that point, transmits a reaction force and lets the rod rotate around it." }));
    this.buildRodAttachment(b);
    this.body.append(section("Actions"));
    this.add(button("Delete anchor", () => this.app.controller.deleteSelection(),
      { icon: ICONS.trash, style: "danger", class: "inspector-action" }));
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
    this.materialControls([b]);

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

  /** Matched compact rows, with material guidance in native delayed hover help. */
  private materialControls(objects: Array<Body | Wall>): void {
    const root = el("div", { class: "material-controls" });
    for (const [property, label, maximum, help] of [
      ["restitution", "Restitution", 1, RESTITUTION_HELP],
      ["friction", "Friction", 10, FRICTION_HELP],
    ] as const) {
      const control = slider(label, () => objects[0][property],
        value => objects.forEach(item => { item[property] = value; }), 0, maximum,
        { fmt: value => value.toFixed(2), onCommit: this.commit,
          log: property === "friction", logFloor: 0.01 });
      control.root.classList.add("material-control");
      const caption = control.root.querySelector<HTMLElement>(".lbl")!;
      const range = control.root.querySelector<HTMLInputElement>('input[type="range"]')!;
      caption.title = help;
      range.title = help;
      for (const input of control.root.querySelectorAll("input")) input.setAttribute("aria-description", help);
      root.append(this.group.add(control).root);
    }
    this.target.append(root);
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
      }, { tooltip: `Set restitution e to ${e} and friction to ${mu}.` });
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
    const anchors = sel.filter((o): o is Body =>
      o instanceof Body && o.isAnchor && !o.isPulley);
    const pulleys = sel.filter((o): o is Body => o instanceof Body && o.isPulley);
    const walls = sel.filter((o): o is Wall => o instanceof Wall);
    const springs = sel.filter((o): o is SpringLink => o instanceof SpringLink);
    const rods = sel.filter((o): o is DistanceLink => o instanceof DistanceLink);
    const pulleyStrings = sel.filter((o): o is PulleyLink => o instanceof PulleyLink);
    const parts: string[] = [];
    if (bodies.length) parts.push(countNoun(bodies.length, "body", "bodies"));
    if (anchors.length) parts.push(countNoun(anchors.length, "anchor"));
    if (pulleys.length) parts.push(countNoun(pulleys.length, "pulley"));
    if (walls.length) parts.push(countNoun(walls.length, "wall"));
    if (springs.length) parts.push(countNoun(springs.length, "spring/string", "springs/strings"));
    if (rods.length) parts.push(countNoun(rods.length, "rod"));
    if (pulleyStrings.length) {
      parts.push(countNoun(pulleyStrings.length, "pulley string"));
    }
    this.body.append(el("div", { text: parts.join(", ") + " selected",
      style: "font-weight:600;margin-bottom:6px" }));


    if (bodies.length > 0) {
      const first = bodies[0];
      const resizableBodies = bodies.filter((b) => !this.app.world.isPulleyParticle(b));
      this.typeGroup(pluralNoun(bodies.length, "Body", "Bodies"), bodies.length, "body");
      this.add(slider("Mass", () => first.mass,
        (v) => bodies.forEach((b) => { b.mass = v; }), 0.001, 10000.0,
        { unit: "kg", log: true, onCommit: this.commit }));
      if (resizableBodies.length > 0) {
        this.add(slider("Radius", () => resizableBodies[0].radius,
          (v) => resizableBodies.forEach((b) => { b.radius = v; }), 0.01, 10.0,
          { unit: "m", log: true, onCommit: this.commit }));
      }
      this.materialControls(bodies);
      this.materialButtons(bodies);
      this.colourRow(bodies);
      this.addHalf(
        checkbox("Locked", () => first.locked,
          (v) => { bodies.forEach((b) => { b.locked = v; }); this.commit(); },
          "Hold the bodies permanently in place as fixed points or obstacles (K)."),
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
      this.typeGroup(pluralNoun(anchors.length, "Anchor"), anchors.length, "anchor");
      this.add(slider("Radius", () => af.radius,
        (v) => anchors.forEach((a) => { a.radius = v; }), 0.01, 10.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Size of the anchors." }));
      this.materialControls(anchors);
      this.materialButtons(anchors);
      this.colourRow(anchors);
      this.add(checkbox("Collides", () => af.collides,
        (v) => { anchors.forEach((a) => { a.collides = v; }); this.commit(); },
        "Let bodies collide with these anchors. Off, they pass through."));
    }

    if (pulleys.length > 0) {
      this.typeGroup(pluralNoun(pulleys.length, "Pulley"), pulleys.length, "pulley");
      this.target.append(el("div", { class: "dim",
        text: "Pulley wheels are fixed, non-colliding assembly points. " +
              "Drag a wheel to reposition or mount it; select its string to " +
               "edit the total natural length." }));
      const links = this.app.world.links.filter((link): link is PulleyLink =>
        link instanceof PulleyLink && pulleys.includes(link.pulley));
      if (links.length > 0) this.addTensionToggle(links);
    }

    if (walls.length > 0) {
      const wf = walls[0];
      this.typeGroup(pluralNoun(walls.length, "Wall"), walls.length, "wall");
      this.add(slider("Thickness", () => wf.thickness,
        (v) => walls.forEach((w) => { w.thickness = v; }), 0.01, 2.0,
        { unit: "m", log: true, fmt: (v) => v.toFixed(2), onCommit: this.commit }));
      this.materialControls(walls);
      this.colourRow(walls);
    }

    if (springs.length > 0) {
      const sf = springs[0];
      this.typeGroup(pluralNoun(springs.length, "Spring/string", "Springs & strings"),
                     springs.length, "spring");
      this.add(slider("Stiffness", () => sf.stiffness,
        (v) => springs.forEach((s) => { s.stiffness = v; }), 0.01, 100000.0,
        { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Force per metre of stretch, k in F = -k x." }));
      this.add(slider("Damping", () => sf.damping,
        (v) => springs.forEach((s) => { s.damping = v; }), 0.0, 500.0,
        { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to stretching and compressing, which bleeds " +
                   "energy out of the oscillation." }));
      this.buildElasticModel(springs);
      this.addTensionToggle(springs);
    }

    if (rods.length > 0) {
      const rf = rods[0];
      this.typeGroup(pluralNoun(rods.length, "Rod"), rods.length, "rod");
      this.add(slider("Length", () => rf.length,
        (v) => rods.forEach((r) => { r.length = v; }), 0.01, 100.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Fixed separation the rods hold between their bodies." }));
      const strings = rods.filter((link) => link.isRope);
      if (strings.length > 0) this.addTensionToggle(strings);
    }


    if (pulleyStrings.length > 0) {
      const pf = pulleyStrings[0];
      this.typeGroup(pluralNoun(pulleyStrings.length, "Pulley string"),
                     pulleyStrings.length, "pulley");
      this.add(slider("String length", () => pf.length,
        (v) => pulleyStrings.forEach((p) => { p.length = v; }), 0.01, 100.0,
        { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Total inextensible string length: both straight legs " +
                    "and the wrapped section around each wheel." }));
      this.addTensionToggle(pulleyStrings);
    }

    this.endGroups();
    this.actionButtons();
    // selective deletion: remove just one kind of thing from the selection
    const groups: Array<[Selectable[], string, string]> = [
      [bodies, "body", "bodies"], [anchors, "anchor", "anchors"],
      [pulleys, "pulley", "pulleys"], [walls, "wall", "walls"],
      [springs, "spring", "springs"], [rods, "rod", "rods"],
      [pulleyStrings, "pulley string", "pulley strings"],
    ];
    const nonEmpty = groups.filter(([g]) => g.length > 0);
    if (nonEmpty.length >= 2) {
      this.body.append(section("Delete ..."));
      const grid = el("div", { class: "btn-grid-2" });
      for (const [grp, singular, plural] of nonEmpty) {
        const counted = countNoun(grp.length, singular, plural);
        grid.append(button(`Delete ${counted}`,
          () => this.deleteObjs([...grp], singular, plural),
          { style: "danger",
            tooltip: `Delete only the selected ${pluralNoun(grp.length, singular, plural)}, keeping the rest of the ` +
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

  private deleteObjs(objs: Selectable[], singular: string,
                     plural = `${singular}s`): void {
    // These buttons are the bulk path by definition ("Delete every body
    // (500)"), so they take the batched route rather than paying the
    // per-object world edit and reconciliation scan.
    this.app.controller.deleteObjects(objs);
    this.app.pushUndo();
    this.app.toast(`Deleted ${countNoun(objs.length, singular, plural)} - ` +
                   `Ctrl+Z restores ${objs.length === 1 ? "it" : "them"}`);
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
    const setEndpoint = (point: "a" | "b", axis: "x" | "y", value: number): void => {
      w[point][axis] = value;
      // Mount geometry is structural scene state. Refresh it before the
      // delayed editor commits its undo snapshot, not merely on the next
      // canvas paint, so undo/redo and structural digests capture one coherent
      // wall-plus-pulley edit.
      this.app.world.syncPulleyMounts();
    };
    this.nameEdit(w);
    this.addHalf(
      numEdit("x1", () => w.a.x, (v) => setEndpoint("a", "x", v),
              "m", this.commit, fmt3dp),
      numEdit("y1", () => w.a.y, (v) => setEndpoint("a", "y", v),
              "m", this.commit, fmt3dp));
    this.addHalf(
      numEdit("x2", () => w.b.x, (v) => setEndpoint("b", "x", v),
              "m", this.commit, fmt3dp),
      numEdit("y2", () => w.b.y, (v) => setEndpoint("b", "y", v),
              "m", this.commit, fmt3dp));
    this.add(slider("Thickness", () => w.thickness, (v) => { w.thickness = v; },
      0.01, 2.0, { unit: "m", log: true, fmt: (v) => v.toFixed(2),
        onCommit: this.commit, tooltip: "Width of the wall across its length." }));
    this.body.append(section("Material"));
    this.materialControls([w]);

    this.colourRow([w]);
    this.actionButtons();
  }

  /** Swap a link object in place (elastic string <-> inelastic string). */
  private replaceLink(oldLink: SpringLink | DistanceLink,
                       newLink: SpringLink | DistanceLink): void {
    const world = this.app.world;
    const i = world.links.indexOf(oldLink);
    newLink.showTensionVectors = oldLink.showTensionVectors;
    if (i >= 0) world.links[i] = newLink;
    this.app.setSelection([newLink]);
    this.app.pushUndo();
  }

  private buildLink(link: SpringLink | DistanceLink | PulleyLink): void {
    const app = this.app;
    if (link instanceof PulleyLink) {
      this.body.append(el("div", { text: "Pulley string (inelastic)",
        style: "font-weight:600;margin-bottom:6px" }));
      this.add(slider("String length", () => link.length, (v) => { link.length = v; },
        0.01, 100.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Total length of both legs and the wrapped section. The " +
                   "string is rigid in tension and free when slack." }));
      this.body.append(el("div", { class: "dim",
        text: "The wheel is fixed and non-colliding. A mounted wheel follows " +
              "its wall endpoint; both particles remain ordinary colliding " +
              "bodies and may slide or swing freely." }));
    } else if (link instanceof SpringLink) {
      const isString = link.tensionOnly;
      this.body.append(el("div", { text: isString ? "String (elastic)" : "Spring",
        style: "font-weight:600;margin-bottom:6px" }));
      this.add(slider("Natural length", () => link.restLength, (v) => { link.restLength = v; },
        0.01, 50.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Length at which it exerts no force." }));
      this.add(slider("Stiffness", () => link.stiffness, (v) => { link.stiffness = v; },
        0.01, 100000.0, { unit: "N/m", log: true, onCommit: this.commit,
          tooltip: "Force per metre of stretch, k in F = -k x." }));
      this.add(slider("Damping", () => link.damping, (v) => { link.damping = v; },
        0.0, 500.0, { unit: "Ns/m", fmt: (v) => v.toFixed(2), onCommit: this.commit,
          tooltip: "Resistance to stretching and compressing, which bleeds " +
                   "energy out of the oscillation." }));
      this.buildElasticModel([link]);
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
      } else {
        this.sub("Rod coordinates");
        this.add(segmented(["A → B", "B → A"],
          () => link.originAtA ? "A → B" : "B → A",
          (value) => {
            link.originAtA = value === "A → B";
            this.commit();
            this.markDirty();
          },
          "Choose which endpoint is the zero used by attached-particle position fields."));
        this.buildRodAttachmentsList(link);
      }
    }
    if (link instanceof PulleyLink || link instanceof SpringLink || link.isRope) {
      this.sub("Analysis");
      this.addTensionToggle([link]);
    }
    this.sub("Actions");
    this.add(button("Delete", () => app.controller.deleteSelection(),
      { icon: ICONS.trash, style: "danger", class: "inspector-action" }));
  }

  /** Modulus entry and the ideal law alongside the canonical stiffness controls. */
  private buildElasticModel(links: SpringLink[]): void {
    const first = links[0];
    const multiple = links.length > 1;
    const helpId = "elastic-modulus-help";
    const errorId = "elastic-modulus-error";
    const help = el("p", { id: helpId, class: "elastic-help" });
    const error = el("p", { id: errorId, class: "error-text", role: "alert",
      text: "Enter a non-negative modulus that gives stiffness no greater than 1e9 N/m." });
    error.hidden = true;
    const currentModulus = (): number => {
      const value = elasticModulus(first) ?? 0;
      // λ/l then k*l can differ by a few ulps for unequal natural lengths.
      const same = links.every(link => {
        const other = elasticModulus(link);
        return other !== null && Math.abs(other - value) <=
          4 * Number.EPSILON * Math.max(Math.abs(other), Math.abs(value));
      });
      return same ? value : NaN;
    };
    const modulus = numEdit("Modulus λ", currentModulus, value => {
      // Validate every conversion before writing any selected link.
      const values = links.map(link => stiffnessForModulus(value, link.restLength));
      if (values.some(stiffness => stiffness === null)) return false;
      links.forEach((link, index) => { link.stiffness = values[index]!; });
    }, "N", this.commit, value => Number.isNaN(value) ? "Mixed"
      : String(Number(value.toPrecision(15))), {
      disabled: () => links.some(link => elasticModulus(link) === null),
      tooltip: "Modulus of elasticity in newtons, λ = k × natural length. This is not Young’s modulus in pascals.",
    });
    const input = modulus.root.querySelector("input")!;
    input.setAttribute("aria-describedby", `${helpId} ${errorId}`);
    const values = el("dl", { class: "elastic-readings" });
    const fields = ["Current length L", "Extension x", "Ideal elastic force", "Ideal elastic energy"];
    const outputs = fields.map(label => {
      const output = el("dd");
      values.append(el("dt", { text: label }), output);
      return output;
    });
    const state = el("span", { class: "elastic-state" });
    const ideal = button("Set damping to zero", () => {
      links.forEach(link => { link.damping = 0; });
      this.commit();
    }, { tooltip: "Remove axial damping from every selected spring and elastic string." });
    const note = el("p", { class: "elastic-help" });
    const explanation = el("details", { class: "elastic-explanation" },
      el("summary", { text: "How these values work" }),
      el("p", { class: "elastic-help", text:
        "l is natural length; x = L − l. Changing natural length keeps stiffness k. " +
        "Set length before modulus when copying a question. Modulus λ is in newtons, not pascals." }),
      el("p", { class: "elastic-help", text:
        "These ideal values use entered stiffness. Damping and solver limits can change " +
        "the simulated force. Elastic strings have zero force and energy when x ≤ 0; " +
        "springs can also push when compressed." }));
    const card = el("div", { class: "elastic-model" },
      el("div", { class: "elastic-heading" }, el("strong", { text: "Hooke’s law" }), state),
      el("div", { class: "elastic-equations" },
        el("p", { class: "elastic-equation", text: "F = k x = λx / l" }),
        el("p", { class: "elastic-equation", text: "E = ½ k x² = λx² / (2l)" })),
      modulus.root, help, error, values, note, ideal.root, explanation);
    this.add({ root: card, refresh: () => {
      modulus.refresh?.();
      error.hidden = input.getAttribute("aria-invalid") !== "true";
      const unavailable = input.disabled;
      const helpText = unavailable
        ? "Set a positive natural length to use a modulus. Stiffness remains available."
        : multiple
          ? "One modulus for all selected links, using each natural length. Mixed means different values."
          : "λ = k l. Set natural length before modulus.";
      if (help.textContent !== helpText) help.textContent = helpText;
      values.hidden = multiple;
      if (!multiple) {
        const analysis = analyseElasticLink(first);
        const readings = [`${analysisNumber(analysis.length)} m`, `${analysisNumber(analysis.extension)} m`,
          `${analysisNumber(Math.abs(analysis.force))} N${analysis.force < 0 ? " thrust" : analysis.force > 0 ? " tension" : ""}`,
          `${analysisNumber(analysis.energy)} J`];
        outputs.forEach((output, index) => {
          if (output.textContent !== readings[index]) output.textContent = readings[index];
        });
        if (state.textContent !== analysis.state) state.textContent = analysis.state;
      } else if (state.textContent !== `${links.length} links`) state.textContent = `${links.length} links`;
      const damped = links.some(link => link.damping > 0);
      ideal.root.hidden = !damped;
      const noteText = this.app.perfMode
        ? "Performance mode approximates elastic motion. Use Normal mode for quantitative study."
        : damped ? "Set damping to zero for an ideal elastic model."
          : "Ideal values exclude damping and solver limits.";
      if (note.textContent !== noteText) note.textContent = noteText;
    } });
  }

  private buildRodAttachmentsList(rod: DistanceLink): void {
    this.sub("Attached to rod");
    const output = el("div", { class: "rod-attachment-list" });
    let signature = "";
    this.add({ root: output, refresh: () => {
      const attached = this.app.world.bodies.filter((body) =>
        body.rodAttachmentId === rod.id).sort((a, b) =>
        a.rodAttachmentT - b.rodAttachmentT || a.id - b.id);
      const next = JSON.stringify(attached.map((body) =>
        [body.id, body.name, body.isPivot, body.rodAttachmentT * rod.length]));
      if (signature === next) return;
      signature = next;
      if (attached.length === 0) {
        output.replaceChildren(el("div", { class: "dim", text:
          "Nothing attached. Place an anchor or particle close to the rod." }));
        return;
      }
      output.replaceChildren(...attached.map((body) => {
        const row = el("button", { type: "button", class: "rod-attachment-item",
          title: `Select ${body.name}` },
          el("span", { text: body.isPivot ? "Anchor" : body.name }),
          el("span", { class: "dim", text:
            `${(body.rodAttachmentT * rod.length).toFixed(3)} m from A` }));
        row.addEventListener("click", () => this.app.setSelection([body]));
        return row;
      }));
    } });
  }

  private buildSinglePulley(): void {
    this.body.append(el("div", { text: "Pulley wheel",
      style: "font-weight:600;margin-bottom:6px" }));
    this.body.append(el("div", { class: "dim",
      text: "A fixed, non-colliding axle. It has no editable material or " +
            "motion properties. Drag the wheel to reposition it; release near " +
            "a wall end to mount it. Delete it to release the two particles " +
             "as an ordinary inelastic string." }));
    const link = this.app.world.links.find((candidate) =>
      candidate instanceof PulleyLink && candidate.pulley === this.app.selection[0]);
    if (link instanceof PulleyLink) {
      this.sub("Analysis");
      this.addTensionToggle([link], "Show four equal-tension force vectors: " +
        "two on the particles and two on the pulley contacts.");
      const readout = el("div", { class: "pulley-readout", role: "group",
        "aria-label": "Pulley force and motion" });
      const readings = [
        ["Tension", "Shared string tension, in newtons."],
        ["Path", "Current routed string length / natural string length, in metres."],
        ["Leg rates", "Rates of change of legs A and B; positive means lengthening."],
        ["Constraint rate", "Rate of change of the total string path; near zero when taut."],
        ["Axle reaction", "Support balancing string and wheel-contact loads: rightward/upward components, in newtons."],
      ].map(([name, help]) => {
        const caption = el("span", { class: "pulley-reading-name", text: `${name}:`,
          title: help, tabindex: "0", "aria-description": help });
        const value = el("span", { class: "pulley-reading-value" });
        readout.append(el("span", {}, caption, " ", value));
        return { value, caption, help };
      });
      this.add({ root: readout, refresh: () => {
        const p = analysePulley(link, this.app.world);
        const values = [
          `${p.tension.toFixed(3)} N`,
          `${p.pathLength.toFixed(3)} / ${p.naturalLength.toFixed(3)} m`,
          `${p.legRateA.toFixed(3)}, ${p.legRateB.toFixed(3)} m/s`,
          `${p.constraintRate.toExponential(2)} m/s`,
          `(${p.axleReactionX.toFixed(2)}, ${p.axleReactionY.toFixed(2)}) N`,
        ];
        readings.forEach(({ value, caption, help }, index) => {
          if (value.textContent !== values[index]) value.textContent = values[index];
          if (index !== 0 && index !== 4) return;
          const period = p.forceInterval === null ? "Current forces." :
            `Average forces: ${p.forceInterval.start.toPrecision(4)}–${p.forceInterval.end.toPrecision(4)} s.`;
          const description = `${help} ${period}`;
          if (caption.title !== description) {
            caption.title = description; caption.setAttribute("aria-description", description);
          }
        });
      } });
    }
    this.sub("Actions");
    this.add(button("Delete wheel", () => this.app.controller.deleteSelection(),
      { icon: ICONS.trash, style: "danger", class: "inspector-action" }));
  }

  /** Retained navigation between the wheel, string and both editable masses. */
  private buildPulleyAssembly(link: PulleyLink): void {
    this.sub("Pulley assembly");
    const group = el("div", { class: "pulley-assembly", role: "group",
      "aria-label": "Pulley assembly", "data-inspector-navigation": "" });
    const parts: Array<{ target: Selectable; label: () => string; detail: () => string;
                        name: () => string }> = [
      { target: link.a, label: () => `Particle A · ${link.a.name}`,
        detail: () => `${fmt3g(link.a.mass)} kg`, name: () => `particle A: ${link.a.name}` },
      { target: link.b, label: () => `Particle B · ${link.b.name}`,
        detail: () => `${fmt3g(link.b.mass)} kg`, name: () => `particle B: ${link.b.name}` },
      { target: link.pulley, label: () => "Wheel", detail: () => "Fixed axle",
        name: () => "pulley wheel" },
      { target: link, label: () => "String", detail: () => `${fmt3g(link.length)} m`,
        name: () => "pulley string" },
    ];
    for (const part of parts) {
      const title = el("span", { class: "pulley-part-label" });
      const detail = el("span", { class: "pulley-part-detail" });
      const row = el("button", { type: "button", class: "pulley-part" }, title, detail);
      const current = this.app.selection[0] === part.target;
      row.disabled = current;
      if (current) row.setAttribute("aria-current", "true");
      row.addEventListener("click", () => {
        this.app.setSelection([part.target]);
        this.refresh();
        this.body.scrollTop = 0;
        this.body.focus({ preventScroll: true });
      });
      group.append(row);
      this.group.add({ root: row, refresh: () => {
        const label = part.label();
        const value = part.detail();
        const name = `Select ${part.name()}`;
        if (title.textContent !== label) title.textContent = label;
        if (detail.textContent !== value) detail.textContent = value;
        if (row.getAttribute("aria-label") !== name) row.setAttribute("aria-label", name);
      } });
    }
    this.body.append(group);
  }

  private addTensionToggle(links: Array<SpringLink | DistanceLink | PulleyLink>,
                           tooltip = "Show the axial force this link applies " +
                             "to each endpoint. Hover an arrow for its column vector."): void {
    this.add(checkbox("Tension vectors",
      () => links.every((link) => link.showTensionVectors),
      (value) => {
        for (const link of links) link.showTensionVectors = value;
        this.app.invalidateCanvas();
      }, tooltip));
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
    const gravityPreset = segmented(["0", "9.8", "9.81", "10"],
      () => [0, 9.8, 9.81, 10].find((value) =>
        Math.abs(world.gravity - value) < 1e-12)?.toString() ?? "",
      (value) => {
        world.gravity = Number(value);
        app.invalidateEnergy();
        app.invalidateCanvas();
        this.commit();
      }, "Common exam gravity values in metres per second squared");
    gravityPreset.root.classList.add("gravity-presets");
    this.body.append(gravityPreset.root);
    this.group.add(gravityPreset);
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
    this.add(perfModeBanner(app,
      "Solver settings cannot be set in performance mode."));
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
      }, "Field name", "Force field name", 80));
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
          // Invalid source is intentionally retained so it can be fixed in
          // place. It is still an edit and must be undoable just like a
          // valid formula; the compiled field remains atomically disabled.
          app.pushUndo();
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
        }, { icon: ICONS.close, style: "ghost",
             tooltip: `Remove driver for ${name}` }).root);
        this.body.append(row);
      }
    }
    this.buildPlaybackEvents();
  }

  private buildPlaybackEvents(): void {
    const app = this.app;
    app.playbackEventTracking = true;
    this.body.append(section("Playback events"));
    const card = el("div", { class: "event-rule-card" });
    const choices: Array<[string, PlaybackEventKind | null, string]> = [
      ["Off", null, "Keep recording events without pausing."],
      ["First collision", "contact", "Pause when two collidable objects first touch."],
      ["Apex", "apex", "Pause when the selected particle reaches the top of its motion."],
      ["Line crossing", "line-crossing", "Pause when the selected particle crosses the chosen x or y line."],
      ["String taut", "string-taut", "Pause when a slack string or spring first becomes taut."],
      ["Pulley stop", "pulley-stop", "Pause when either pulley particle reaches the wheel's safety stop."],
    ];
    const helpId = "pause-event-description";
    const select = el("select", { "aria-label": "Pause playback at event",
      "aria-describedby": helpId });
    for (const [label, value, description] of choices) {
      select.append(el("option", { value: value ?? "", text: label,
        title: description }));
    }
    const description = el("div", { id: helpId,
      class: "dim event-option-description" });
    const syncDescription = (): void => {
      const active = choices.find(([, value]) => (value ?? "") === select.value) ?? choices[0];
      description.textContent = active[2];
      // Native option tooltips are platform-dependent; the select title
      // guarantees that hovering the closed control explains its current rule.
      select.title = active[2];
    };
    select.addEventListener("change", () => {
      app.pauseOnEvent = select.value === "" ? null : select.value as PlaybackEventKind;
      syncDescription();
    });
    const selectControl = this.group.add({ root: el("label", { class: "event-rule-field" },
      select), refresh: () => {
      const value = app.pauseOnEvent ?? "";
      if (select.value !== value) {
        select.value = value;
        syncDescription();
      }
    } });
    syncDescription();
    card.append(selectControl.root, description);

    const lineControls = el("div", { class: "event-line-controls" });
    const axis = this.group.add(segmented(["x line", "y line"],
      () => app.playbackEvents.lineAxis === "x" ? "x line" : "y line",
      (value) => {
        app.playbackEvents.lineAxis = value === "x line" ? "x" : "y";
        app.playbackEvents.prime(app.world);
      }, "Axis used by the line-crossing event."));
    const line = this.group.add(numEdit("Position", () => app.playbackEvents.lineValue, (value) => {
      app.playbackEvents.lineValue = value;
      app.playbackEvents.prime(app.world);
    }, "m", undefined, fmt3dp));
    lineControls.append(axis.root, line.root);
    card.append(lineControls);
    this.group.add({ root: el("span"), refresh: () => {
      lineControls.hidden = app.pauseOnEvent !== "line-crossing";
    } });
    this.body.append(card);

    const historyHeader = el("div", { class: "event-history-header" },
      el("strong", { text: "Event history" }));
    const toggleHistory = el("button", { class: "event-history-toggle",
      type: "button", text: this.eventHistoryOpen ? "Hide" : "Show",
      "aria-expanded": String(this.eventHistoryOpen) });
    historyHeader.append(toggleHistory);
    this.body.append(historyHeader);

    const history = el("div", { class: "event-history" });
    history.hidden = !this.eventHistoryOpen;
    toggleHistory.addEventListener("click", () => {
      this.eventHistoryOpen = !this.eventHistoryOpen;
      history.hidden = !this.eventHistoryOpen;
      toggleHistory.textContent = this.eventHistoryOpen ? "Hide" : "Show";
      toggleHistory.setAttribute("aria-expanded", String(this.eventHistoryOpen));
    });
    const clear = button("Clear history", () => app.playbackEvents.clear(app.world),
      { icon: ICONS.trash, style: "ghost",
        tooltip: "Discard recorded event rows without changing the scene." });
    history.append(clear.root);
    this.group.add(clear);
    const table = el("div", { class: "inspector-event-table" });
    let signature = "";
    this.add({ root: table, refresh: () => {
      const events = app.playbackEvents.events;
      const next = `${events.length}:${events.at(-1)?.id ?? 0}`;
      if (next === signature) return;
      signature = next;
      if (events.length === 0) {
        table.replaceChildren(el("div", { class: "dim", text:
          "No events yet. Select a particle for its apex and line crossings, then play or step." }));
        return;
      }
      table.replaceChildren(...events.slice(-8).reverse().map((event) =>
        el("div", { class: "inspector-event-row" },
          el("time", { text: `${event.time.toFixed(4)} s` }),
          el("div", { class: "event-row-copy" },
            el("strong", { text: event.label }),
            el("span", { text: event.value })))));
    } });
    history.append(table);
    this.body.append(history);
  }

  // ------------------------------------------------------------------- view
  private buildCentreModel(): void {
    const x = el("output", { "aria-label": "Centre of mass x", "aria-live": "off", tabindex: "0" });
    const y = el("output", { "aria-label": "Centre of mass y", "aria-live": "off", tabindex: "0" });
    const readings = el("dl", { class: "centre-readings" },
      el("dt", { text: "Centre x" }), el("dd", {}, x),
      el("dt", { text: "Centre y" }), el("dd", {}, y));
    const empty = el("p", { class: "centre-help centre-empty", text: "No movable particles to measure." });
    const root = el("div", { class: "centre-model", role: "group", "aria-label": "Centre of mass coordinates" },
      readings, empty);
    this.add({ root, refresh: () => {
      root.hidden = !this.app.view.com;
      if (root.hidden) return;
      const centre = this.app.world.centreOfMass();
      const available = centre !== null && Number.isFinite(centre.x) && Number.isFinite(centre.y);
      readings.hidden = !available;
      empty.hidden = available;
      if (!available) {
        empty.textContent = centre === null ? "No movable particles to measure." : "Coordinates are unavailable.";
        return;
      }
      for (const [output, value] of [[x, centre.x], [y, centre.y]] as const) {
        const text = `${Number(value.toPrecision(12))} m`;
        const exact = `Full stored value: ${value} m.`;
        if (output.textContent !== text) output.textContent = text;
        if (output.title !== exact) {
          output.title = exact;
          output.setAttribute("aria-description", exact);
        }
      }
    } });
  }

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
        "Red arrow showing the realised average net force over the latest " +
        "physics step, including contacts and constraints (F = m delta-v / delta-t).");
    this.add(slider("Vector size", () => view.vectorScale,
      (v) => { view.vectorScale = v; }, 0.02, 20.0,
      { unit: "x", log: true, fmt: (v) => v.toFixed(2),
        tooltip: "Length multiplier for every vector arrow." }));

    this.body.append(section("Analysis"));
    const perfOn = (): boolean => app.perfMode;
    this.add(perfModeBanner(app,
      "Motion trails are not available in performance mode."));
    this.add(checkbox("Motion trails", () => view.trails, (v) => app.setTrails(v),
      "Draw a fading path behind each moving body (T).", perfOn));
    this.add(slider("Trail length", () => view.trailLen,
      (v) => { view.trailLen = Math.round(v); }, 10, 10000,
      { unit: "pts", fmt: (v) => v.toFixed(0), step: 10, log: true,
        disabled: perfOn,
        tooltip: "Points kept per trail, which sets how far back it reaches." }));
    const trailWarn = el("div", { class: "error-text",
      text: "Long trails or many bodies at once can lower the frame rate.",
      style: "display:none" });
    this.add({ root: trailWarn, refresh: () => {
      const moving = app.world.bodies.reduce((n, b) => n + (b.locked ? 0 : 1), 0);
      const heavy = view.trails && !app.perfMode &&
        (view.trailLen >= 1500 || moving >= 40 || view.trailLen * moving >= 30000);
      trailWarn.style.display = heavy ? "" : "none";
    } });
    chk("Centre of mass", () => view.com, (v) => { view.com = v; },
        "Mass-weighted centre of movable particles; right and up are positive. " +
        "Includes resting particles asleep in Performance mode. Anchors, locked or held particles " +
        "and internal rod coordinates are omitted; walls and light links carry no mass. " +
        "Focus or hover a coordinate for full stored precision.");
    this.buildCentreModel();
    chk("Contact normals", () => view.contacts, (v) => { view.contacts = v; },
        "Draw an arrow at every contact resolved this frame.");
    chk("Broadphase grid", () => view.spatialGrid, (v) => { view.spatialGrid = v; },
        "Show the cells collision detection uses to find candidate pairs (G).");

    this.body.append(section("Graph dock"));
    const graph = el("select", { "aria-label": "Graph shown in the dock",
      title: "Displacement, distance and velocity graphs follow the selected particle." });
    for (const [label, value] of [
      ["Off", "Off"], ["Energy", "Energy"], ["Momentum", "Mom."],
      ["Phase space", "Phase"], ["Displacement–time", "Displacement"],
      ["Distance–time", "Distance"],
      ["Velocity–time", "Velocity"],
    ] as Array<[string, GraphMode]>) {
      graph.append(el("option", { text: label, value }));
    }
    graph.addEventListener("change", () => app.setGraphMode(graph.value as GraphMode));
    this.add({ root: el("div", { class: "row" },
      el("span", { class: "lbl", text: "Graph" }), graph), refresh: () => {
      if (graph.value !== app.graphMode) graph.value = app.graphMode;
    } });
  }
}
