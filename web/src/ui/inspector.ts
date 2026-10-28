/** Inspector: tabbed side panel editing the selection, world and view.
 *
 * Rebuilt whenever the selection structure changes; while the structure is
 * stable, controls refresh in place on the panel cadence so live values
 * (positions, velocities) stay current without stealing focus.
 */
import { choiceSelect } from "./choice-select";
import { App, GraphMode, Panel } from "../app";
import { BODY_PALETTE, Body, Color, MATERIALS, SCENE_MAX_COORDINATE, Wall } from "../engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../engine/links";
import { DeleteZone, DELETE_ZONE_SHAPES } from "../engine/delete-zone";
import { Driver, ForceField, INTEGRATORS, Integrator } from "../engine/world";
import { PlaybackEventKind, displayForceResultant, forceLedger, projectForce, touchingSlopeWall, sustainedForceLedger, rodMomentAnalysis } from "../education/analysis";
import { forceSymbols } from "../engine/force-diagnostics";
import { analyseElasticLink, elasticModulus, stiffnessForModulus } from "../education/elasticity";
import { Selectable } from "../render/draw";
import { analysisNumber } from "../render/analysis-overlays";
import { isMathRenderable } from "../core/mathfmt";
import { INSPECTOR_W_MAX, INSPECTOR_W_MIN, PHONE_QUERY, RefreshGroup, button,
         checkbox, colourEdit, countNoun, el, fmt3dp, fmt3g, halfRow, isPhone, isTouch,
         tunableNumEdit as numEdit, onMediaChange, pluralNoun, refreshTabs, section, segmented,
         slider, splitterDrag, textEdit, wireTabs } from "./dom";
import { ICONS } from "./icons";
import { NUMERIC_EDIT_EVENT, type NumericEditPhase } from "./numeric-scrub";
import { mathEdit } from "./mathedit";
import { upgradeMath } from "./guide";
import { overlayToggles } from "./panels";
import type { TourInspectorSection, TourInspectorSession } from "./tour";

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
    : o instanceof Wall ? "w" : o instanceof DeleteZone ? "z"
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

/** Static equations remain properly typeset even before the optional font
 * chunk arrives. The shared Guide upgrader replaces this MathML with MathLive. */
function elasticEquation(kind: "force" | "energy"): HTMLElement {
  const node = (tag: string, ...children: Array<Node | string>): MathMLElement => {
    const element = document.createElementNS("http://www.w3.org/1998/Math/MathML", tag);
    element.append(...children); return element;
  };
  const variable = (name: string): MathMLElement => node("mi", name);
  const squared = (): MathMLElement => node("msup", variable("x"), node("mn", "2"));
  const force = kind === "force";
  const equation = node("math", node("mrow", variable(force ? "F" : "E"), node("mo", "="),
    ...(force ? [] : [node("mfrac", node("mn", "1"), node("mn", "2"))]),
    variable("k"), force ? variable("x") : squared(), node("mo", "="),
    node("mfrac", node("mrow", variable("λ"), force ? variable("x") : squared()),
      force ? variable("ℓ") : node("mrow", node("mn", "2"), variable("ℓ")))));
  equation.setAttribute("display", "block"); equation.setAttribute("aria-hidden", "true");
  const root = el("div", { class: "guide-math elastic-equation", role: "math", tabindex: "0",
    "aria-label": force ? "F equals k times x equals lambda times x divided by natural length ell"
      : "E equals one half k times x squared equals lambda times x squared divided by two times natural length ell" }, equation);
  root.dataset.latex = force ? "F=kx=\\frac{\\lambda x}{\\ell}" : "E=\\frac{1}{2}kx^{2}=\\frac{\\lambda x^{2}}{2\\ell}";
  return root;
}

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
  private contextIcon!: HTMLElement;
  private contextType!: HTMLElement;
  private contextName!: HTMLElement;
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

  /** Reveal the tour's actual controls without persisting temporary layout or
   * selection changes. The tour restores this view even when it is skipped. */
  beginTour(): TourInspectorSession {
    const previous = { tab: this.tab, scroll: this.body.scrollTop,
      desktop: this.desktopCollapsed, phone: this.phoneCollapsed,
      selection: [...this.app.selection] };
    const diagrams = new Map(this.app.world.bodies.map(body => [body, body.showForceComponents]));
    const particle = (): Body | undefined => {
      const eligible = (body: Body): boolean => !body.isAnchor && !body.isPivot && !body.isRodEndpoint && !body.isPulley;
      return this.app.selection.find((item): item is Body => item instanceof Body && eligible(item)) ??
        this.app.world.bodies.find(eligible);
    };
    return {
      canShow: section => section !== "particle" && section !== "forces" || particle() !== undefined,
      reveal: (section: TourInspectorSection) => {
        const tab: Tab = section === "graphs" ? "View" : section === "fields" ? "World" : "Selection";
        this.desktopCollapsed = false; this.phoneCollapsed = false;
        this.applyCollapsed();
        if (section === "particle" || section === "forces") {
          const body = particle();
          if (body) {
            if (section === "forces" && !this.app.perfMode && !body.showForceComponents) {
              body.showForceComponents = true; this.app.invalidateCanvas();
            }
            if (this.app.selection.length !== 1 || this.app.selection[0] !== body) this.app.setSelection([body]);
          }
        }
        if (this.tab !== tab) { this.tab = tab; this.rebuild(); }
        else this.refresh();
        const selector = section === "forces" ? ".force-toggle" : section === "particle" ? ".inspector-object-head" :
          section === "graphs" ? '[role="combobox"][aria-label="Graph shown in the dock"]' : ".field-actions";
        const target = this.body.querySelector<HTMLElement>(selector) ?? this.body;
        const panel = this.body.getBoundingClientRect(), box = target.getBoundingClientRect();
        if (box.top < panel.top + 12 || box.bottom > panel.bottom - 12) {
          this.body.scrollTop += box.top - panel.top - 12;
        }
        return target;
      },
      restore: () => {
        for (const [body, enabled] of diagrams) {
          if (this.app.world.bodies.includes(body)) body.showForceComponents = enabled;
        }
        const live = new Set<Selectable>([...this.app.world.bodies, ...this.app.world.walls,
          ...this.app.world.links, ...this.app.world.deleteZones]);
        this.tab = previous.tab;
        this.app.setSelection(previous.selection.filter(item => live.has(item)));
        this.rebuild();
        this.desktopCollapsed = previous.desktop; this.phoneCollapsed = previous.phone;
        this.applyCollapsed(); this.body.scrollTop = previous.scroll;
        this.app.invalidateCanvas();
      },
    };
  }

  tabRecoveryState(): { tab: Tab; forceValuesOpen: boolean; eventHistoryOpen: boolean } {
    const forceValues = this.body.querySelector<HTMLDetailsElement>(".force-values");
    return { tab: this.tab, forceValuesOpen: forceValues?.open ?? this.forceValuesOpen,
      eventHistoryOpen: this.eventHistoryOpen };
  }

  restoreTabPresentation(raw: unknown): void {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const state = (raw as Record<string, unknown>).inspector;
    if (state === null || typeof state !== "object" || Array.isArray(state)) return;
    const data = state as Record<string, unknown>;
    if (typeof data.tab === "string" && TABS.includes(data.tab as Tab)) this.tab = data.tab as Tab;
    if (typeof data.forceValuesOpen === "boolean") {
      this.forceValuesOpen = data.forceValuesOpen;
      const details = this.body.querySelector<HTMLDetailsElement>(".force-values");
      if (details !== null) details.open = data.forceValuesOpen;
    }
    if (typeof data.eventHistoryOpen === "boolean") this.eventHistoryOpen = data.eventHistoryOpen;
    this.markDirty();
  }

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
      if (control.closest("[data-inspector-navigation]") !== null) return;
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
    root.addEventListener(NUMERIC_EDIT_EVENT, event => {
      const phase = (event as CustomEvent<NumericEditPhase>).detail;
      if (this.tab === "View") { app.invalidateCanvas(); return; }
      if (phase === "cancel") app.rollbackEdit();
      else app.beginEdit();
    });
    root.addEventListener("click", (event) => {
      if (this.tab === "View") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || target.closest("button") === null) return;
      if (target.closest("[data-inspector-navigation]") !== null) return;
      if (target.closest('.tabs, .reopen-strip, .mobile-inspector-handle') !== null) return;
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
    this.contextIcon = el("span", { class: "studio-context-icon", "aria-hidden": "true" });
    this.contextType = el("span", { class: "studio-context-type" });
    this.contextName = el("strong", { class: "studio-context-name" });
    const context = el("div", { class: "studio-inspector-heading" }, this.contextIcon,
      el("div", { class: "studio-context-copy" }, this.contextType, this.contextName));
    root.append(context, tabs, this.body);

    // width splitter (persisted)
    const saved = app.settings.inspector_w;
    if (typeof saved === "number") root.style.width = `${clampInspectorW(saved)}px`;
    const applyWidth = (w: number): void => {
      root.style.width = `${clampInspectorW(w)}px`;
      app.resizeCanvas();
    };
    splitterDrag(splitter, (e) => {
      const w = Math.max(INSPECTOR_W_MIN,
                         Math.min(INSPECTOR_W_MAX, root.getBoundingClientRect().right - e.clientX));
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
    app.registerCanvasOverlay(this.handle);
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
    if (collapsed) this.group.cancelInteractions();
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
    const rodMembership = sel.length === 1 ? this.selectedRods(sel[0]).map(rod =>
      `${rod.id}:${this.rodParts(rod).map(body => body.id).join(",")}`).join("|") : "";
    return `sel:${ids}:${drivers}:w${app.world.walls.length}:z${app.world.deleteZones.length}:t${app.controller.tool}${inventory}:p${pulleyMembership}:${bodyRole}:r${rodMembership}`;
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
    this.refreshContext();
    this.group.refreshAll();
  }

  private refreshContext(): void {
    const selection = this.app.selection;
    let kind: string = this.tab, name = this.tab === "World" ? "Simulation setup" : "Canvas & analysis", icon = ICONS.gear;
    if (this.tab === "Selection") {
      const selected = selection[0];
      if (selection.length > 1) { kind = "Selection"; name = `${selection.length} objects`; icon = ICONS.select; }
      else if (!selected) { kind = "Selection"; name = "No selection"; icon = ICONS.select; }
      else if (selected instanceof Body) {
        kind = selected.isPulley ? "Pulley" : selected.isAnchor ? "Anchor" : "Particle";
        name = kind;
        icon = selected.isPulley ? ICONS.pulley : selected.isAnchor ? ICONS.anchor : ICONS.body;
      } else if (selected instanceof DeleteZone) { kind = "Delete zone"; name = kind; icon = ICONS.eraser; }
      else if (selected instanceof Wall) { kind = "Wall"; name = kind; icon = ICONS.wall; }
      else {
        kind = selected instanceof PulleyLink ? "Pulley assembly" : selected instanceof SpringLink ? "Spring" : selected.isRope ? "String" : "Rod";
        name = kind;
        icon = selected instanceof PulleyLink ? ICONS.pulley : selected instanceof SpringLink ? ICONS.spring : selected.isRope ? ICONS.rope : ICONS.rod;
      }
    }
    const context = this.tab === "Selection" ? "Inspector" : this.tab;
    if (this.contextType.textContent !== context) this.contextType.textContent = context;
    if (this.contextName.textContent !== name) this.contextName.textContent = name;
    if (this.contextIcon.dataset.kind !== kind) { this.contextIcon.innerHTML = icon; this.contextIcon.dataset.kind = kind; }
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
    this.refreshContext();
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
    if (app.controller.tool === "eraser") {
      this.sub("Delete tool");
      const modes = ["Erase objects", "Circle zone", "Rectangle zone", "Capsule zone"];
      const values = ["scrub", ...DELETE_ZONE_SHAPES] as const;
      const mode = segmented(modes, () => modes[values.indexOf(app.controller.eraserShape)], value => {
        app.controller.eraserShape = values[modes.indexOf(value)]; app.invalidateCanvas();
      }, "Delete tool mode");
      mode.root.classList.add("delete-zone-modes");
      mode.root.setAttribute("data-inspector-navigation", ""); this.add(mode);
      this.body.append(el("p", { class: "dim", text: "Erase objects now, or drag a persistent zone. Objects touching an enabled zone are removed during playback. Select a zone to edit its shape and dimensions." }));
    }
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
        ["springs", "Springs & strings"], ["rods", "Rods"], ["zones", "Delete zones"],
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
        [world.deleteZones, "delete zone", "delete zones"],
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
      for (const rod of this.selectedRods(selected)) this.buildRodAssembly(rod);
    }
    const objectStart = this.body.childElementCount;
    if (sel.length === 1 && sel[0] instanceof Body) {
      if (sel[0].isPulley) this.buildSinglePulley();
      else if (sel[0].isPivot) this.buildSinglePivot(sel[0]);
      else if (sel[0].isAnchor) this.buildSingleAnchor(sel[0]);
      else this.buildSingleBody(sel[0]);
    } else if (sel.length === 1 && sel[0] instanceof DeleteZone) this.buildDeleteZone(sel[0]);
    else if (sel.length === 1 && sel[0] instanceof Wall) this.buildWall(sel[0]);
    else if (sel.length === 1) {
      this.buildLink(sel[0] as DistanceLink | SpringLink | PulleyLink);
    }
    else this.buildMulti(sel);
    const particle = sel[0];
    if (sel.length === 1) {
      const part = particle instanceof Body ? particle.isPulley ? "Pulley wheel" : particle.isAnchor ? "Anchor" :
        selectedPulley ? (particle === selectedPulley.a ? "Particle A" : "Particle B") : "Particle" :
        particle instanceof DeleteZone ? "Delete zone" : particle instanceof Wall ? "Wall" : particle instanceof PulleyLink ? "Pulley string" :
        particle instanceof SpringLink ? "Spring or string" : "Rod or string";
      const card = el("div", { class: "inspector-object-card", role: "group",
        "aria-label": `${part} properties` }, ...[...this.body.children].slice(objectStart));
      this.body.append(card);
    }
  }

  private buildDeleteZone(zone: DeleteZone): void {
    this.objectHeader(zone); this.sub("Delete zone");
    this.add(checkbox("Enabled", () => zone.enabled, value => { zone.enabled = value; this.commit(); }));
    this.add(segmented([...DELETE_ZONE_SHAPES], () => zone.shape, value => {
      zone.shape = value as typeof zone.shape; this.commit();
    }, "Zone shape"));
    this.addHalf(numEdit("x", () => zone.pos.x, value => { zone.pos.x = value; }, "m", this.commit),
      numEdit("y", () => zone.pos.y, value => { zone.pos.y = value; }, "m", this.commit));
    this.add(slider("Width", () => zone.width, value => { zone.width = value; }, .01, 100,
      { unit: "m", log: true, onCommit: this.commit, tooltip: "Total width; for a circle this is its diameter." }));
    this.add(slider("Height", () => zone.height, value => { zone.height = value; }, .01, 100,
      { unit: "m", log: true, onCommit: this.commit, disabled: () => zone.shape === "circle" }));
    this.add(slider("Angle", () => zone.angle * 180 / Math.PI, value => { zone.angle = value * Math.PI / 180; }, -180, 180,
      { unit: "°", onCommit: this.commit, disabled: () => zone.shape === "circle" }));
    this.body.append(el("p", { class: "dim", text: "Anything touching this zone is removed when the simulation advances. Connected objects are released or removed together. Zones remain until you delete them." }));
    const actions = el("div", { class: "btn-grid-2" });
    actions.append(button("Duplicate", () => this.app.controller.duplicateSelection()).root,
      button("Delete", () => this.app.controller.deleteSelection(), { style: "danger" }).root);
    this.body.append(section("Actions"), actions);
  }

  /** Every object uses one inline name editor with a compact identity cue. */
  private objectHeader(b: Selectable, fallback = ""): void {
    const particle = b instanceof Body && !b.isAnchor;
    const cue = el("span", { class: particle ? "inspector-particle-cue" : "inspector-object-icon", "aria-hidden": "true" });
    if (!particle) {
      const icon = b instanceof DeleteZone ? "eraser" : b instanceof Wall ? "wall" : b instanceof Body ? b.isPulley ? "pulley" : "anchor" :
        b instanceof PulleyLink ? "rope" : b instanceof SpringLink ? b.tensionOnly ? "rope" : "spring" : b.isRope ? "rope" : "rod";
      cue.innerHTML = ICONS[icon];
    }
    const editor = textEdit(() => b.name || fallback, value => {
      b.name = value.trim() || b.name;
      this.commit();
      return true;
    }, "Object name", "Name", 200);
    const input = editor.root as HTMLInputElement;
    input.classList.add("inspector-particle-name");
    input.title = "Click to rename this object";
    const editCue = el("span", { class: "inspector-name-edit-cue", "aria-hidden": "true", text: "✎" });
    const name = el("div", { class: "inspector-name-editor" }, input, editCue);
    const pulley = particle ? this.app.world.links.find(link => link instanceof PulleyLink && (link.a === b || link.b === b)) : undefined;
    const badge = pulley instanceof PulleyLink ? el("span", {
      class: "inspector-pulley-role", text: pulley.a === b ? "A" : "B",
      "aria-label": `Pulley particle ${pulley.a === b ? "A" : "B"}`,
      title: `Particle ${pulley.a === b ? "A" : "B"} in the pulley assembly`,
    }) : null;
    const head = el("div", { class: "inspector-object-head" }, cue, name, badge);
    head.addEventListener("click", event => {
      if (event.target !== input) { input.focus(); input.select(); }
    });
    this.add({ ...editor, root: head, refresh: () => {
      editor.refresh?.();
      if (particle && b instanceof Body) {
        const colour = `rgb(${b.color.join(", ")})`;
        if (cue.style.backgroundColor !== colour) cue.style.backgroundColor = colour;
      }
    } });
  }

  private buildSingleBody(b: Body): void {
    const app = this.app;
    this.objectHeader(b);
    this.add(slider("Mass", () => b.mass, (v) => { b.mass = v; },
      0.001, 10000.0, { unit: "kg", log: true, onCommit: this.commit,
        tooltip: "Mass of the body, both inertial and gravitational." }));
    if (!app.world.isPulleyParticle(b)) {
      this.add(slider("Radius", () => b.radius, (v) => { b.radius = v; },
        0.01, 10.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Size of the body. Mass is set separately." }));
    }
    const onRod = () => b.rodAttachmentId !== null || app.world.links.some(link =>
      link instanceof DistanceLink && !link.isRope && (link.a === b || link.b === b));
    const positionOptions = { readOnly: onRod,
      readOnlyHelp: "Detach from the rod to edit position freely.",
      onReadOnlyAttempt: () => app.toast("Detach from the rod to edit position freely.") };
    this.addHalf(
      numEdit("x", () => b.pos.x, (v) => { if (!onRod()) b.pos.x = v; }, "m", this.commit, fmt3dp, positionOptions),
      numEdit("y", () => b.pos.y, (v) => { if (!onRod()) b.pos.y = v; }, "m", this.commit, fmt3dp, positionOptions));
    this.buildRodAttachment(b);
    this.addHalf(
      numEdit("vx", () => b.vel.x, (v) => { b.vel.x = v; }, "", this.commit, fmt3dp),
      numEdit("vy", () => b.vel.y, (v) => { b.vel.y = v; }, "", this.commit, fmt3dp));
    this.add(slider("Spin", () => b.omega, (v) => { b.omega = b.noRotation ? 0 : v; },
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
    const parent = this.target;
    const controls = el("div", { class: "force-controls", "data-inspector-navigation": "" });
    parent.append(controls);
    this.target = controls;
    const diagram = checkbox("Free-body diagram", () => b.showForceComponents,
      (value) => { b.showForceComponents = value; app.invalidateCanvas(); this.refresh(); },
      "Show labelled forces immediately. After a step, values are averages over the displayed interval.", () => app.perfMode);
    diagram.root.classList.add("force-toggle");
    diagram.root.querySelector("input")!.setAttribute("aria-label", "Free-body forces on canvas");
    this.add(diagram);
    this.add(checkbox("Collision impulses", () => b.showCollisionImpulses,
      value => { b.showCollisionImpulses = value; app.invalidateCanvas(); },
      "Show measured collision impulse J in N·s on impact frames. Sustained reaction and friction stay in N. Pause or step back to inspect an impact.", () => app.perfMode));
    const attachedRod = this.selectedRods(b)[0];
    if (attachedRod !== undefined) this.add(checkbox("Rod moments", () => b.showRodMoments,
      value => { b.showRodMoments = value; if (value) b.showForceComponents = true; app.invalidateCanvas(); },
      "Show this particle's signed force moments about the rod pivot, or its centre of mass without a pivot. Positive means anticlockwise.", () => app.perfMode));
    const impactReadout = el("div", { class: "force-impulses", "aria-label": "Collision impulses" });
    const momentReadout = el("div", { class: "force-moments", "aria-label": "Rod moments" });
    let impactKey = "", momentKey = "";
    this.add({ root: el("div", {}, impactReadout, momentReadout), refresh: () => {
      const enabled = b.showForceComponents && !app.perfMode;
      const impulses = enabled && b.showCollisionImpulses ? app.world.collisionImpulses.filter(entry => entry.bodyId === b.id) : [];
      impactReadout.hidden = impulses.length === 0;
      const nextImpactKey = JSON.stringify(impulses);
      if (nextImpactKey !== impactKey) {
        impactReadout.replaceChildren(...impulses.map(entry => {
          const source = entry.sourceId === null ? app.world.walls.find(wall => wall.id === entry.wallId)?.name :
            app.world.bodies.find(body => body.id === entry.sourceId)?.name;
          return el("div", {}, el("strong", { text: `J: Collision with ${source || "contact"}` }),
            el("div", { class: "force-value-components" },
              el("span", { text: `Jx ${analysisNumber(entry.jx)} N·s` }),
              el("span", { text: `Jy ${analysisNumber(entry.jy)} N·s` })),
            el("div", { class: "faint", text: `t = ${fmt3dp(entry.time)} s` }));
        })); impactKey = nextImpactKey;
      }
      const moment = enabled && b.showRodMoments ? rodMomentAnalysis(app.world, b,
        sustainedForceLedger(app.world, b, forceLedger(app.world, b))) : null;
      momentReadout.hidden = moment === null;
      const nextMomentKey = JSON.stringify(moment);
      if (nextMomentKey !== momentKey) {
        momentReadout.replaceChildren();
        if (moment !== null) momentReadout.append(
          el("strong", { text: `Moments about ${moment.reference}` }),
          el("div", { class: "faint", text: "Anticlockwise + · Clockwise −" }),
          ...moment.entries.map(entry => el("div", { class: "force-moment-row" },
            el("span", { text: entry.label }), el("span", { text: `${analysisNumber(entry.moment)} N·m` }))),
          el("div", { class: "force-resultant", text: `Στ ${analysisNumber(moment.moment)} N·m` }));
        momentKey = nextMomentKey;
      }
    } });

    const readout = el("details", { class: "force-values" },
      el("summary", { text: "Values and sources", "aria-label": "Force values and sources" }));
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
    const notation = el("div", { class: "force-notation", role: "group", "aria-label": "Force notation" });
    let notationKey = "";
    const resultantComponents = el("span", { class: "force-value-components" });
    const resultant = el("div", { class: "force-resultant", "aria-label": "Resultant force" },
      el("span", { class: "force-value-name", text: "Resultant" }), resultantComponents);
    const forceReadout = el("div", { class: "force-readout" }, forceNote, notation, readout, resultant);
    this.add({ root: forceReadout, refresh: () => {
      forceNote.hidden = !b.showForceComponents || app.perfMode;
      readout.hidden = forceNote.hidden;
      forceReadout.hidden = forceNote.hidden;
      if (forceNote.hidden) return;
      const wall = b.forceSlopeWallId === null ? null :
        app.world.walls.find(candidate => candidate.id === b.forceSlopeWallId) ?? null;
      const raw = forceLedger(app.world, b, wall);
      const ledger = sustainedForceLedger(app.world, b, raw);
      const text = ledger.mode === "step-average" && ledger.interval !== null ?
        `${ledger === raw ? "Average" : "Sustained"} forces: ${fmt3dp(ledger.interval.start)}–${fmt3dp(ledger.interval.end)} s.` :
        ledger.mode === "resting" ? "Resting forces: weight and support balance." :
          "Current forces.";
      if (forceNote.textContent !== text) forceNote.textContent = text;
      const present = ledger.entries.filter(entry => Number.isFinite(entry.fx) && Number.isFinite(entry.fy) &&
        (Math.abs(entry.fx) + Math.abs(entry.fy) > 1e-10 ||
          Number.isFinite(entry.axialForce) && (entry.axialForce ?? 0) > 1e-10));
      const symbols = forceSymbols(present);
      const nextNotationKey = JSON.stringify(present.map(entry => [entry.id, symbols.get(entry.id), entry.label]));
      if (notationKey !== nextNotationKey) {
        notation.replaceChildren(...present.map(entry => el("abbr", {
          text: symbols.get(entry.id)!, title: entry.label, "aria-label": entry.label, tabindex: "0",
        })));
        notationKey = nextNotationKey;
      }
      notation.hidden = present.length === 0;
      const net = displayForceResultant(ledger);
      const netText = [`Fx ${analysisNumber(net.fx)} N`, `Fy ${analysisNumber(net.fy)} N`];
      for (let i = 0; i < netText.length; i++) {
        let component = resultantComponents.children[i] as HTMLElement | undefined;
        if (component === undefined) {
          component = el("span", { class: "force-component" });
          resultantComponents.append(component);
        }
        if (component.textContent !== netText[i]) component.textContent = netText[i];
      }
      if (!readout.open) return;
      const entries = present;
      const key = entries.map(entry => entry.id).join(",");
      for (const entry of entries) {
        let row = rows.get(entry.id);
        if (row === undefined) {
          const name = el("span", { class: "force-value-name" });
          const components = el("span", { class: "force-value-components" });
          const root = el("li", {}, name, components);
          row = { root, name, components };
          rows.set(entry.id, row);
        }
        const symbol = symbols.get(entry.id);
        const name = symbol === undefined ? entry.label : `${symbol}: ${entry.label}`;
        if (row.name.textContent !== name) row.name.textContent = name;
        const text = [`Fx ${analysisNumber(entry.fx)} N`, `Fy ${analysisNumber(entry.fy)} N`];
        if ("axialForce" in entry && entry.axialForce !== undefined) {
          text.push(`Tension ${analysisNumber(entry.axialForce)} N`);
        }
        if (ledger.basis !== null && ("kind" in entry && (entry.kind === "weight" || entry.kind === "gravity"))) {
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

    const slopeHelp = "Replace the weight arrow with its components along and perpendicular to the contact slope. Other forces stay unchanged.";
    const resolve = checkbox("Resolve weight on slope", () => b.resolveWeightOnSlope || b.forceSlopeWallId !== null,
      value => {
        b.resolveWeightOnSlope = value;
        const walls = app.world.walls.filter(wall => touchingSlopeWall(b, wall));
        b.forceSlopeWallId = value && walls.length === 1 ? walls[0].id : null;
        if (value) b.showForceComponents = true;
        app.invalidateCanvas();
        this.refresh();
      }, slopeHelp, () => app.perfMode || !app.world.walls.some(wall => touchingSlopeWall(b, wall)));
    resolve.root.classList.add("weight-resolve-toggle");
    const resolveInput = resolve.root.querySelector<HTMLInputElement>("input")!;
    resolveInput.setAttribute("aria-label", "Resolve weight on slope");
    const resolveRefresh = resolve.refresh;
    resolve.refresh = () => {
      const walls = app.world.walls.filter(wall => touchingSlopeWall(b, wall));
      if (b.forceSlopeWallId !== null && !walls.some(wall => wall.id === b.forceSlopeWallId)) {
        b.forceSlopeWallId = null;
        app.invalidateCanvas();
      }
      if (b.resolveWeightOnSlope && b.forceSlopeWallId === null && walls.length === 1) {
        b.forceSlopeWallId = walls[0].id;
        app.invalidateCanvas();
      }
      resolveRefresh?.();
      resolve.root.title = app.perfMode ? "Weight components are available in Normal mode." :
        resolveInput.disabled ? "No slope in contact." : slopeHelp;
      resolveInput.setAttribute("aria-description", resolve.root.title);
    };
    const slopeSection = el("div", { class: "weight-slope-controls" });
    controls.append(slopeSection);
    this.target = slopeSection;
    this.add(resolve);
    const explanation = el("p", { class: "weight-resolve-note", text: "W∥ and W⊥ replace W" });
    this.add({ root: explanation, refresh: () => {
      explanation.hidden = app.perfMode || !(b.resolveWeightOnSlope || b.forceSlopeWallId !== null) ||
        !app.world.walls.some(wall => touchingSlopeWall(b, wall));
      const text = "W∥ and W⊥ replace W";
      if (explanation.textContent !== text) explanation.textContent = text;
    } });
    const slope = choiceSelect("Resolve forces relative to a slope", () => {
      const walls = app.world.walls.filter(wall => touchingSlopeWall(b, wall));
      return [{ value: "", label: walls.length === 0 ? "No slope in contact" : "No slope selected" },
        ...walls.map(wall => ({ value: String(wall.id), label: wall.name }))];
    }, () => b.forceSlopeWallId === null ? "" : String(b.forceSlopeWallId), value => {
      const wall = app.world.walls.find(wall => String(wall.id) === value && touchingSlopeWall(b, wall));
      b.forceSlopeWallId = wall?.id ?? null;
      b.resolveWeightOnSlope = b.forceSlopeWallId !== null;
      if (b.forceSlopeWallId !== null) b.showForceComponents = true;
      app.invalidateCanvas();
      this.refresh();
    }, { tooltip: slopeHelp, disabled: () => app.perfMode || !app.world.walls.some(wall => touchingSlopeWall(b, wall)) });
    const slopeTrigger = slope.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    const slopeRow = el("div", { class: "row weight-slope-row", role: "group", "aria-label": "Slope reference" },
      el("span", { class: "lbl", text: "Slope reference" }), slope.root);
    const slopeControl = { root: slopeRow, dispose: slope.dispose, refresh: () => {
      const walls = app.world.walls.filter(wall => touchingSlopeWall(b, wall));
      if (b.forceSlopeWallId !== null && !walls.some(wall => wall.id === b.forceSlopeWallId)) {
        b.forceSlopeWallId = null;
        app.invalidateCanvas();
      }
      const disabled = app.perfMode || walls.length === 0;
      slopeRow.hidden = walls.length <= 1 || !(b.resolveWeightOnSlope || b.forceSlopeWallId !== null);
      slope.refresh?.();
      slopeRow.classList.toggle("disabled", disabled);
      const disabledState = String(disabled);
      if (slopeRow.getAttribute("aria-disabled") !== disabledState) slopeRow.setAttribute("aria-disabled", disabledState);
      const help = app.perfMode ? "Weight components are available in Normal mode." : disabled ? "No slope in contact." : slopeHelp;
      if (slopeRow.title !== help) slopeRow.title = help;
      if (slopeTrigger.title !== help) slopeTrigger.title = help;
      if (slopeTrigger.getAttribute("aria-description") !== help) slopeTrigger.setAttribute("aria-description", help);
    } };
    this.add(slopeControl);
    const performanceNote = el("div", { class: "faint settings-note force-performance-note",
      text: "Free-body diagrams are available in Normal mode." });
    this.add({ root: performanceNote, refresh: () => {
        performanceNote.hidden = !app.perfMode;
        diagram.root.title = app.perfMode ? "Free-body diagrams are available in Normal mode." :
          "Show labelled forces immediately. After a step, values are averages over the displayed interval.";
      } });
    this.target = parent;
  }

  /** A bulk display preference, with each particle retaining its own contact
   * plane. A corner must never borrow another particle's slope reference. */
  private buildGroupWeightResolution(particles: Body[]): void {
    const app = this.app;
    const enabled = (body: Body): boolean => body.resolveWeightOnSlope || body.forceSlopeWallId !== null;
    const contacts = new Map<Body, Wall[]>();
    const updateContacts = (): void => {
      for (const body of particles) contacts.set(body, app.world.walls.filter(wall => touchingSlopeWall(body, wall)));
    };
    updateContacts();
    const help = "Replace only each particle’s weight arrow with components parallel and perpendicular to its own contact plane. Other forces stay unchanged.";
    const resolve = checkbox("Resolve weight on slope", () => particles.every(enabled), value => {
      updateContacts();
      for (const body of particles) {
        const walls = contacts.get(body)!;
        body.resolveWeightOnSlope = value;
        body.forceSlopeWallId = !value ? null : walls.length === 1 ? walls[0].id
          : walls.some(wall => wall.id === body.forceSlopeWallId) ? body.forceSlopeWallId : null;
        if (value) body.showForceComponents = true;
      }
      app.invalidateCanvas(); this.refresh();
    }, help, () => app.perfMode || !particles.some(body => contacts.get(body)!.length > 0));
    resolve.root.classList.add("weight-resolve-toggle");
    const input = resolve.root.querySelector<HTMLInputElement>("input")!;
    input.setAttribute("aria-label", "Resolve weight on slope");
    const note = el("p", { class: "weight-resolve-note group-weight-note" });
    const references = el("div", { class: "group-weight-references" });
    const section = el("div", { class: "weight-slope-controls" }, resolve.root, note, references);
    const choices = new Map<Body, { row: HTMLElement; label: HTMLElement; choice: ReturnType<typeof choiceSelect> }>();
    const refresh = (): void => {
      updateContacts();
      let changed = false, needsChoice = 0, airborne = 0;
      for (const body of particles) {
        const walls = contacts.get(body)!;
        if (body.forceSlopeWallId !== null && !walls.some(wall => wall.id === body.forceSlopeWallId)) {
          body.forceSlopeWallId = null; changed = true;
        }
        if (body.resolveWeightOnSlope && body.forceSlopeWallId === null && walls.length === 1) {
          body.forceSlopeWallId = walls[0].id; changed = true;
        }
        if (enabled(body) && walls.length === 0) airborne++;
        if (enabled(body) && walls.length > 1 && body.forceSlopeWallId === null) needsChoice++;
        let item = choices.get(body);
        // Most groups need no per-particle fields. Allocate only for a particle
        // at a corner, then retain its control while contact geometry changes.
        if (!item && enabled(body) && walls.length > 1) {
          const label = el("span", { class: "lbl" });
          const choice = choiceSelect(`Slope reference for ${body.name}`, () => [
            { value: "", label: "Choose contact plane" },
            ...contacts.get(body)!.map(wall => ({ value: String(wall.id), label: wall.name })),
          ], () => body.forceSlopeWallId === null ? "" : String(body.forceSlopeWallId), value => {
            const wall = app.world.walls.find(wall => String(wall.id) === value && touchingSlopeWall(body, wall));
            body.forceSlopeWallId = wall?.id ?? null;
            body.resolveWeightOnSlope = true;
            body.showForceComponents = true;
            app.invalidateCanvas(); this.refresh();
          }, { tooltip: help, disabled: () => app.perfMode || !enabled(body) || contacts.get(body)!.length === 0 });
          const row = el("div", { class: "row weight-slope-row group-weight-reference" }, label, choice.root);
          references.append(row); item = { row, label, choice }; choices.set(body, item);
        }
        if (item) {
          item.row.hidden = !enabled(body) || walls.length <= 1;
          if (item.label.textContent !== body.name) item.label.textContent = body.name;
          const name = `Slope reference for ${body.name}`;
          for (const element of item.choice.root.querySelectorAll('[role="combobox"], [role="listbox"]')) {
            if (element.getAttribute("aria-label") !== name) element.setAttribute("aria-label", name);
          }
          item.choice.refresh?.();
        }
      }
      resolve.refresh?.();
      input.indeterminate = particles.some(enabled) && !particles.every(enabled);
      const description = app.perfMode ? "Weight components are available in Normal mode."
        : input.disabled ? "No selected particle is in contact with a plane." : help;
      if (resolve.root.title !== description) resolve.root.title = description;
      if (input.getAttribute("aria-description") !== description) input.setAttribute("aria-description", description);
      const text = app.perfMode ? "Free-body diagrams and weight components are available in Normal mode."
        : "Only weight is split into W∥ and W⊥; other force arrows stay unchanged." +
          (needsChoice ? ` Choose a contact plane for ${countNoun(needsChoice, "particle")}.` : "") +
          (airborne ? ` ${countNoun(airborne, "particle")} will resolve on contact.` : "");
      if (note.textContent !== text) note.textContent = text;
      note.hidden = !app.perfMode && !particles.some(enabled);
      if (changed) app.invalidateCanvas();
    };
    this.add({ root: section, refresh });
    this.group.add({ root: section, dispose: () => { for (const { choice } of choices.values()) choice.dispose?.(); } });
  }

  private buildRodAttachment(b: Body): void {
    if (b.rodAttachmentId === null) return;
    const rod = this.app.world.links.find((link) =>
      link instanceof DistanceLink && !link.isRope && link.id === b.rodAttachmentId);
    if (!(rod instanceof DistanceLink)) return;
    const parent = this.target;
    const head = el("div", { class: "rod-attachment-heading" },
      el("span", { text: "Rod attachment" }),
      button(`Rod ${rod.id}`, () => this.app.setSelection([rod]),
        { style: "ghost", tooltip: "Select this rod" }).root);
    const section = el("div", { class: "rod-attachment-editor", role: "group", "aria-label": "Rod attachment" }, head);
    (parent ?? this.body).append(section);
    this.target = section;
    const distance = (): number => (rod.originAtA ? b.rodAttachmentT : 1 - b.rodAttachmentT) * rod.length;
    const input = slider(`From ${rod.originAtA ? "A" : "B"}`, distance, value => {
      if (!Number.isFinite(value) || value < 0 || value > rod.length || rod.length <= 1e-12) {
        this.app.toast(`Distance must be between 0 and ${rod.length.toFixed(3)} m`);
        return false;
      }
      b.rodAttachmentT = rod.originAtA ? value / rod.length : 1 - value / rod.length;
      b.pos.set(rod.a.pos.x + b.rodAttachmentT * (rod.b.pos.x - rod.a.pos.x),
        rod.a.pos.y + b.rodAttachmentT * (rod.b.pos.y - rod.a.pos.y));
      this.app.invalidateCanvas();
      return true;
    }, 0, rod.length, { unit: "m", onCommit: this.commit, fmt: fmt3dp, step: 0.001,
      scrub: { sensitivity: 0.01, step: 0.001 }, disabled: () => rod.length <= 1e-12,
      tooltip: "Distance along the rod from its selected origin." });
    input.root.querySelector('input[type="text"]')!.setAttribute("aria-label", "Position along rod (m)");
    input.root.querySelector('input[type="range"]')!.setAttribute("aria-label", "Position along rod");
    this.add(input);
    if (!b.isPivot) {
      this.add(button("Detach from rod", () => {
        b.rodAttachmentId = null;
        // The role key changes, so commit rebuilds immediately. Scheduling
        // another rebuild would discard a draft started in the new x/y field.
        this.commit();
      }, { class: "rod-detach", tooltip: "Release this particle; its forces and links remain attached to the particle." }));
    }
    this.target = parent;
  }

  private buildSinglePivot(b: Body): void {
    this.objectHeader(b);
    this.body.append(el("div", { class: "dim", text:
      "An anchor attached to a point on the rod. It fixes that point, transmits a reaction force and lets the rod rotate around it." }));
    this.buildRodAttachment(b);
    this.body.append(section("Actions"));
    this.add(button("Delete anchor", () => this.app.controller.deleteSelection(),
      { icon: ICONS.trash, style: "danger", class: "inspector-action" }));
  }

  /** An anchor is a fixed attachment point: only its size, position, whether
   * it collides, its name and its material matter. No mass or motion controls. */
  private buildSingleAnchor(b: Body): void {
    this.objectHeader(b);
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
          scrub: { sensitivity: property === "friction" ? 0.01 : 0.005, step: 0.01 },
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
    const grid = el("div", { class: "btn-grid material-presets" });
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
      const particles = bodies.filter(body => !body.isRodEndpoint);
      if (particles.length) {
        this.sub("Forces on canvas");
        const diagrams = checkbox("Free-body diagrams", () => particles.every(body => body.showForceComponents),
          value => {
            for (const body of particles) body.showForceComponents = value;
            this.app.invalidateCanvas();
          }, "Show or hide free-body diagrams for every selected particle.", () => this.app.perfMode);
        const input = diagrams.root.querySelector<HTMLInputElement>("input")!;
        input.setAttribute("aria-label", "Free-body forces on canvas");
        diagrams.root.classList.add("force-toggle");
        const refresh = diagrams.refresh;
        diagrams.refresh = () => {
          refresh?.();
          const mixed = particles.some(body => body.showForceComponents) && !particles.every(body => body.showForceComponents);
          if (input.indeterminate !== mixed) input.indeterminate = mixed;
        };
        this.add(diagrams);
        this.buildGroupWeightResolution(particles);
      }
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
      if (links.length > 0) this.addPulleyResultantToggle(links);
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
      this.addTensionToggle(pulleyStrings, "Show four tension arrows: one on each particle and one at each side of the pulley.");
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
    this.objectHeader(w);
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
    const wallLength = (): number => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    this.add(numEdit("Angle", () => Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180 / Math.PI,
      value => {
        const length = wallLength();
        if (!Number.isFinite(value) || !Number.isFinite(length) || length <= 1e-9) return false;
        // Reduce degrees before converting to radians so even large finite
        // whole-turn inputs cannot overflow. Rotation changes geometry only.
        const degrees = value % 360, radians = degrees * Math.PI / 180;
        let cos = Math.cos(radians), sin = Math.sin(radians);
        // Only exact cardinal angles snap to zero; tiny valid angles retain
        // their direction rather than being swallowed by an epsilon.
        if (degrees % 180 === 0) sin = 0;
        if (Math.abs(degrees % 180) === 90) cos = 0;
        const cx = (w.a.x + w.b.x) / 2, cy = (w.a.y + w.b.y) / 2;
        const dx = length * cos / 2, dy = length * sin / 2;
        const coordinates = [cx - dx, cy - dy, cx + dx, cy + dy];
        if (coordinates.some(coordinate => !Number.isFinite(coordinate) ||
            Math.abs(coordinate) > SCENE_MAX_COORDINATE)) return false;
        w.a.set(coordinates[0], coordinates[1]);
        w.b.set(coordinates[2], coordinates[3]);
        this.app.world.syncPulleyMounts();
      }, "°", this.commit, value => String(Number(value.toPrecision(12))), {
        disabled: () => !Number.isFinite(wallLength()) || wallLength() <= 1e-9,
        tooltip: "From endpoint 1 to endpoint 2, anticlockwise from horizontal. " +
          "Rotates about the wall centre and keeps its length. Enter applies; Escape cancels.",
      }));
    const thickness = slider("Thickness", () => w.thickness, (v) => { w.thickness = v; },
      0.01, 2.0, { unit: "m", log: true, fmt: (v) => v.toFixed(2),
        onCommit: this.commit, tooltip: "Width of the wall across its length." });
    thickness.root.classList.add("wall-thickness");
    this.add(thickness);
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
    newLink.name = oldLink.name;
    if (i >= 0) world.links[i] = newLink;
    this.app.setSelection([newLink]);
    this.app.pushUndo();
  }

  private buildLink(link: SpringLink | DistanceLink | PulleyLink): void {
    const app = this.app;
    const kind = link instanceof PulleyLink ? "Pulley string" : link instanceof SpringLink ?
      link.tensionOnly ? "Elastic string" : "Spring" : link.isRope ? "Inelastic string" : "Rod";
    this.objectHeader(link, `${kind} ${link.id}`);
    if (link instanceof PulleyLink) {
      this.add(slider("String length", () => link.length, (v) => { link.length = v; },
        0.01, 100.0, { unit: "m", log: true, onCommit: this.commit,
          tooltip: "Total length of both legs and the wrapped section. The " +
                   "string is rigid in tension and free when slack." }));
    } else if (link instanceof SpringLink) {
      const isString = link.tensionOnly;
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
      }
    }
    if (link instanceof PulleyLink || link instanceof SpringLink || link.isRope) {
      this.sub("Analysis");
      this.addTensionToggle([link], link instanceof PulleyLink
        ? "Show four tension arrows: one on each particle and one at each side of the pulley." : undefined);
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
        elasticEquation("force"), elasticEquation("energy")),
      modulus.root, help, error, values, explanation);
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
    } });
    upgradeMath(card);
  }

  private selectedRods(selected: Selectable): DistanceLink[] {
    return this.app.world.links.filter((link): link is DistanceLink => link instanceof DistanceLink &&
      !link.isRope && (link === selected || selected instanceof Body &&
        (selected.rodAttachmentId === link.id || link.a === selected || link.b === selected)));
  }

  private rodParts(rod: DistanceLink): Body[] {
    return this.app.world.bodies.filter(body => !body.isRodEndpoint &&
      (body.rodAttachmentId === rod.id || rod.a === body || rod.b === body));
  }

  /** Keep the rod and every visible particle/support reachable from any part. */
  private buildRodAssembly(rod: DistanceLink): void {
    this.sub("Rod assembly");
    const group = el("div", { class: "rod-assembly pulley-assembly", role: "group",
      "aria-label": `Rod assembly: ${rod.name || `Rod ${rod.id}`}`, "data-inspector-navigation": "" });
    const fraction = (body: Body): number => body === rod.a ? 0 : body === rod.b ? 1 : body.rodAttachmentT;
    const parts: Array<{ target: Selectable; label: () => string; detail: () => string; name: () => string }> = [
      { target: rod, label: () => rod.name || `Rod ${rod.id}`, detail: () => `${fmt3g(rod.length)} m`,
        name: () => `rod: ${rod.name || `Rod ${rod.id}`}` },
      ...this.rodParts(rod).sort((a, b) => fraction(a) - fraction(b) || a.id - b.id).map(body => ({
        target: body,
        label: () => `${body.isAnchor || body.isPivot ? "Anchor" : "Particle"} · ${body.name}`,
        detail: () => `${fmt3dp((rod.originAtA ? fraction(body) : 1 - fraction(body)) * rod.length)} m from ${rod.originAtA ? "A" : "B"}`,
        name: () => `${body.isAnchor || body.isPivot ? "rod anchor" : "rod particle"}: ${body.name}`,
      })),
    ];
    for (const part of parts) {
      const title = el("span", { class: "pulley-part-label" }), detail = el("span", { class: "pulley-part-detail" });
      const row = el("button", { type: "button", class: "rod-part pulley-part" }, title, detail);
      const current = this.app.selection[0] === part.target;
      row.disabled = current;
      if (current) row.setAttribute("aria-current", "true");
      row.addEventListener("click", () => {
        this.app.setSelection([part.target]); this.refresh();
        this.body.scrollTop = 0; this.body.focus({ preventScroll: true });
      });
      group.append(row);
      this.group.add({ root: row, refresh: () => {
        const label = part.label(), value = part.detail(), name = `Select ${part.name()}`;
        if (part.target === rod) group.setAttribute("aria-label", `Rod assembly: ${label}`);
        if (title.textContent !== label) title.textContent = label;
        if (detail.textContent !== value) detail.textContent = value;
        if (row.getAttribute("aria-label") !== name) row.setAttribute("aria-label", name);
      } });
    }
    if (parts.length === 1) group.append(el("div", { class: "dim", text:
      "Nothing attached. Place an anchor or particle close to the rod." }));
    this.body.append(group);
  }

  private buildSinglePulley(): void {
    this.objectHeader(this.app.selection[0] as Body);
    this.body.append(el("div", { class: "dim",
      text: "A fixed, non-colliding axle. It has no editable material or " +
            "motion properties. Drag the wheel to reposition it; release near " +
            "a wall end to mount it. Delete it to release the two particles " +
             "as an ordinary inelastic string." }));
    const link = this.app.world.links.find((candidate) =>
      candidate instanceof PulleyLink && candidate.pulley === this.app.selection[0]);
    if (link instanceof PulleyLink) {
      this.sub("Analysis");
      this.addPulleyResultantToggle([link]);
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

  private addPulleyResultantToggle(links: PulleyLink[]): void {
    const control = checkbox("Resultant tension vector",
      () => links.every(link => link.showResultantTensionVector), value => {
        for (const link of links) link.showResultantTensionVector = value;
        this.app.invalidateCanvas();
      }, "Show the resultant of both string tensions at each selected pulley wheel. " +
        "Select the string to show the four individual tension arrows.");
    const input = control.root.querySelector<HTMLInputElement>("input")!;
    control.root.setAttribute("data-inspector-navigation", "");
    input.setAttribute("aria-label", "Resultant tension vector");
    const refresh = control.refresh;
    control.refresh = () => {
      refresh?.();
      const mixed = links.some(link => link.showResultantTensionVector) &&
        !links.every(link => link.showResultantTensionVector);
      if (input.indeterminate !== mixed) input.indeterminate = mixed;
    };
    this.add(control);
  }

  private addTensionToggle(links: Array<SpringLink | DistanceLink | PulleyLink>,
                           tooltip = "Show the axial force this link applies " +
                             "to each endpoint. Hover an arrow for its column vector."): void {
    const control = checkbox("Tension vectors",
      () => links.every((link) => link.showTensionVectors),
      (value) => {
        for (const link of links) link.showTensionVectors = value;
        this.app.invalidateCanvas();
      }, tooltip);
    control.root.setAttribute("data-inspector-navigation", "");
    this.add(control);
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
    const description = el("div", { id: helpId,
      class: "dim event-option-description" });
    const syncDescription = (): void => {
      const active = choices.find(([, value]) => value === app.pauseOnEvent) ?? choices[0];
      if (description.textContent !== active[2]) description.textContent = active[2];
    };
    const choice = choiceSelect("Pause playback at event",
      choices.map(([label, value, description]) => ({ label, value: value ?? "", description })),
      () => app.pauseOnEvent ?? "", value => {
        app.pauseOnEvent = value === "" ? null : value as PlaybackEventKind;
        syncDescription();
      });
    choice.root.querySelector("[role=combobox]")!.setAttribute("aria-describedby", helpId);
    const selectControl = this.group.add({ ...choice,
      root: el("div", { class: "event-rule-field" }, choice.root),
      refresh: () => { choice.refresh?.(); syncDescription(); } });
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
    toggleHistory.setAttribute("aria-controls", "inspector-event-history");
    const actions = el("div", { class: "event-history-actions" });
    historyHeader.append(actions);
    this.body.append(historyHeader);

    const history = el("div", { class: "event-history", id: "inspector-event-history" });
    history.hidden = !this.eventHistoryOpen;
    toggleHistory.addEventListener("click", () => {
      this.eventHistoryOpen = !this.eventHistoryOpen;
      history.hidden = !this.eventHistoryOpen;
      toggleHistory.textContent = this.eventHistoryOpen ? "Hide" : "Show";
      toggleHistory.setAttribute("aria-expanded", String(this.eventHistoryOpen));
      clear.root.hidden = !this.eventHistoryOpen;
    });
    const clear = button("Clear", () => { app.playbackEvents.clear(app.world); this.refresh(); },
      { icon: ICONS.trash, style: "ghost", class: "event-history-clear",
        tooltip: "Discard recorded event rows without changing the scene.",
        isEnabled: () => app.playbackEvents.events.length > 0 });
    clear.root.setAttribute("aria-label", "Clear history");
    clear.root.hidden = !this.eventHistoryOpen;
    actions.append(clear.root, toggleHistory);
    this.group.add(clear);
    const table = el("div", { class: "inspector-event-table" });
    let signature = "";
    this.add({ root: table, refresh: () => {
      const events = app.playbackEvents.events;
      const next = `${events.length}:${events.at(-1)?.id ?? 0}`;
      if (next === signature) return;
      signature = next;
      if (events.length === 0) {
        table.replaceChildren(el("div", { class: "event-history-empty" },
          el("strong", { text: "No events yet" }),
          el("p", { class: "dim", text: "Play or step to record contacts and string events. " +
            "Select a particle to also record its apex and line crossings." })));
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
    chk("Force diagram numbers", () => view.forceIds, (v) => { view.forceIds = v; },
        "Match force captions to particles with small numbered badges.");
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
    const graph = choiceSelect("Graph shown in the dock", [
      { label: "Off", value: "Off" }, { label: "Energy", value: "Energy" },
      { label: "Momentum", value: "Mom." }, { label: "Phase space", value: "Phase" },
      { label: "Displacement–time", value: "Displacement" },
      { label: "Distance–time", value: "Distance" }, { label: "Velocity–time", value: "Velocity" },
    ], () => app.graphMode, value => app.setGraphMode(value as GraphMode), {
      tooltip: "Displacement, distance and velocity graphs follow the selected particle.",
    });
    this.add({ ...graph, root: el("div", { class: "row" },
      el("span", { class: "lbl", text: "Graph" }), graph.root) });
  }
}
