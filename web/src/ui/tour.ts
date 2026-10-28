/** First-run tour with spotlights on visible controls.
 * Runs automatically once, supports skipping and replay, and restores the
 * previous play state on close. Completion is stored in tour_done. */
import type { App } from "../app";
import { PRESETS } from "../scene/presets";
import { ModalFocus, countNoun, el, isTouch } from "./dom";
import { spotlightOutline } from "./tour-spotlight";

export type TourInspectorSection = "particle" | "forces" | "graphs" | "fields";
export interface TourInspectorSession {
  canShow(section: TourInspectorSection): boolean;
  reveal(section: TourInspectorSection): HTMLElement | null;
  restore(): void;
}
export interface TourInspectorHost { beginTour(): TourInspectorSession; }

/** One stop on the tour.
 *
 * `target` is a CSS selector for the element to spotlight; omit it for a
 * centred card with no anchor. A selector LIST spotlights the union of
 * everything it matches, which is how a step that talks about two things
 * at once (the scene and the readout below it) can point at both instead
 * of leaving half its sentence unhighlighted. `enter` runs when the step
 * is shown - used to put the app in a state the step is talking about
 * (running, paused), never to change what the user has built.
 */
export interface Step {
  target?: string;
  title: string;
  body: string;
  touchBody?: string; // replaces `body` on touch devices
  enter?: (app: App) => void;
  inspector?: TourInspectorSection;
}

export const STEPS: Step[] = [
  {
    title: "Welcome to Mechanica",
    body: "A physics sandbox: build mechanical systems, run them, and " +
          "measure what they do. Everything is real SI units - metres, " +
          "kilograms, seconds, newtons - and everything runs in this " +
          "browser. New sessions start with Pulley on an incline: inspect weight components, reaction, friction and tension before pressing Play.",
  },
  {
    // the bar below the canvas is half of what this step describes
    target: "#canvas-wrap, #hintbar",
    title: "The scene",
    body: "Scroll to zoom at the cursor; right- or middle-drag to pan. The bottom bar shows coordinates, object counts and energy change. Friction and drag can physically remove energy, so a decrease alone is not a solver error. To check numerical drift, use a conservative scene without those losses.",
    touchBody: "Pinch with two fingers to zoom and pan. The bottom bar shows object counts and energy change. Friction and drag can physically remove energy, so a decrease alone is not a solver error. To check numerical drift, use a conservative scene without those losses.",
  },
  {
    target: "#toolbar",
    title: "Run it",
    body: "Press play or the spacebar to run. The arrows step forwards or back; hold one to repeat, faster the longer you hold. Steps stop at collisions so you can inspect them. Edit the clock to re-simulate to a time. Reset returns to this scene’s start.",
    touchBody: "Press play to run. The arrows step forwards or back; hold one to repeat, faster the longer you hold. Steps stop at collisions so you can inspect them. Edit the clock to re-simulate to a time. Reset returns to this scene’s start.",
    enter: (app) => { app.playing = true; },
  },
  {
    target: "#canvas-wrap",
    title: "Reach in while it runs",
    body: "Drag a body while it runs and you move it without throwing it - " +
          "it resumes the motion it already had. Hold it still and it stays " +
          "pinned under your cursor while everything else piles into it. " +
          "Drag the green arrow on a selected body to set its velocity.",
    touchBody: "Drag a body while it runs and you move it without throwing " +
               "it - it resumes the motion it already had. Hold it still and " +
               "it stays pinned while everything else piles into it. Drag " +
               "the green arrow on a selected body to set its velocity.",
  },
  {
    target: "#palette",
    title: "Build your own",
    body: "Place particles, walls and anchors. Click two points to draw a rod, then slowly drag a particle onto it to attach; an anchor near the rod supports it. Strings and springs join two bodies. The pulley tool creates a wheel, two particles and their string. Select an object to adjust it in the Inspector.",
    touchBody: "Place particles, walls and anchors. Tap two points to draw a rod, then slowly drag a particle onto it to attach; an anchor near the rod supports it. Strings and springs join two bodies. The pulley tool creates a wheel, two particles and their string. Select an object to adjust it in the panel.",
    enter: (app) => { app.playing = false; },
  },
  {
    // On a phone the inspector is a closed drawer, so there is nothing to
    // point at - but the handle that opens it is right there, and is
    // exactly what a phone user needs to be shown. Whichever of the two is
    // visible gets the ring; the other is skipped as hidden.
    target: "#inspector, #inspector-handle",
    title: "Edit particles and rods",
    inspector: "particle",
    body: "Select a particle to change its mass, material and forces. Drag a numeric label to adjust; moving slowly is finer. Rod-attached positions are read-only: use the distance along the rod beneath x/y, or detach the particle to position it freely. Select the rod to edit its geometry and attachments.",
    touchBody: "The panel shows a particle’s mass, material and forces. Rod-attached positions are read-only: use the distance along the rod beneath x/y, or detach the particle. Select the rod to edit its geometry and attachments.",
  },
  {
    target: "#canvas-wrap, #inspector, #inspector-handle",
    title: "Read a free-body diagram",
    inspector: "forces",
    body: "Enable Free-body diagram in the particle’s panel (Normal mode). W is weight, R reaction, F friction, T tension and f applied force. Resolve weight on slope replaces W with parallel W∥ and perpendicular W⊥ components; other arrows stay unchanged. Use Values and sources for origins and interval-averaged readings.",
    touchBody: "Free-body diagram shows the particle’s forces (Normal mode). W is weight, R reaction, F friction, T tension and f applied force. Resolve weight on slope replaces W with parallel W∥ and perpendicular W⊥ components; other arrows stay unchanged. Use Values and sources for origins and interval-averaged readings.",
  },
  {
    target: "#inspector, #inspector-handle",
    title: "Measure the motion",
    inspector: "graphs",
    body: "Choose a graph in View, or use keys 1–6. Select a particle for displacement, distance, velocity or phase space. Data opens a larger graph with labelled axes and coordinate inspection. Zoom, then left- or right-drag to pan. Numbers and CSV retain the recorded values; PNG exports the graph. Return to live resumes scrolling after panning history.",
    touchBody: "Choose a graph in View. Select a particle for displacement, distance, velocity or phase space. Data opens a larger graph with labelled axes and coordinate inspection. Zoom, then drag to pan. Numbers and CSV retain the recorded values; PNG exports the graph. Return to live resumes scrolling after panning history.",
  },
  {
    // Introduce force fields and their guide without changing the scene.
    target: "#inspector, #inspector-handle",
    title: "Write your own physics",
    inspector: "fields",
    body: "The World tab ends with custom force fields: type a formula for " +
          "Fx and Fy and it is applied to every body. Write -y*5 for a " +
          "spring toward the axis, or -0.5*vx for drag. They render as " +
          "typeset maths as you type, and the Formula guide beside them " +
          "lists every variable and function, with recipes to start from.",
    touchBody: "The World tab ends with custom force fields: type a formula " +
               "for Fx and Fy and it is applied to every body. Write -y*5 " +
               "for a spring toward the axis, or -0.5*vx for drag. The " +
               "Formula guide beside them lists every variable and " +
               "function, with recipes to start from.",
  },
  {
    // the two buttons this step is about, not the whole toolbar
    target: "#btn-library, #btn-settings",
    title: "Start from a worked example",
    body: `The Library has ${PRESETS.length} ready-made simulations - orbits, pendulums, ` +
          "rods, pulleys, inclined planes, collisions and more - each with a note on what " +
          "it demonstrates. It is the fastest way in: load one, run it, " +
          "then take it apart. The gear beside it holds settings, and help " +
          "with every shortcut.",
  },
];

const TOUR_KEY = "tour_done";

interface Rect { x: number; y: number; w: number; h: number; }

/** Elements a selector matches that are actually laid out and on screen.
 *
 * Tested by client rects rather than `offsetParent`, which is null for
 * every position:fixed element - the phone drawer handle is fixed, so an
 * offsetParent test silently discarded the one thing a phone user needs
 * pointing at. An element that is display:none or [hidden] has no rects at
 * all, which is what actually distinguishes the collapsed inspector and
 * the desktop-hidden handle from the one that is really on screen. */
function visibleTargets(selector: string): Element[] {
  return [...document.querySelectorAll(selector)].filter((n) => {
    if (n.getClientRects().length === 0) return false;
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  });
}

export class Tour {
  private app: App;
  private root: HTMLElement | null = null;
  private scrim!: HTMLElement;
  private cells: HTMLElement[] = []; // pooled dark tiles
  private outline!: SVGSVGElement;
  private outlinePath!: SVGPathElement;
  private card!: HTMLElement;
  private focus!: ModalFocus;
  private shell: HTMLElement | null = null;
  private index = 0;
  private wasPlaying = false;
  private inspectorSession: TourInspectorSession | null = null;
  private inspectorTarget: HTMLElement | null = null;
  private steps: Step[] = [];
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.finish();
    else if (e.key === "ArrowRight") this.go(1);
    else if (e.key === "ArrowLeft") this.go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  private reflow = (): void => { this.revealInspector(); this.place(); };

  constructor(app: App, private inspector?: TourInspectorHost) {
    this.app = app;
  }

  get visible(): boolean { return this.root !== null; }

  /** Run the tour once per browser, on the very first visit. */
  maybeAutoStart(): void {
    if (this.app.settings[TOUR_KEY] === true) return;
    this.start();
  }

  start(): void {
    if (this.root !== null) return;
    this.inspectorSession = this.inspector?.beginTour() ?? null;
    // steps whose target is missing (a panel hidden on this viewport) are
    // dropped rather than shown pointing at nothing
    // Same visibility test place() uses, so the two can never disagree:
    // existing in the DOM is not enough, since a panel that is collapsed or
    // below the phone breakpoint is present but has nothing to ring. A step
    // with no visible target would otherwise show as an unanchored card
    // describing something the reader cannot see.
    this.steps = STEPS.filter(
      (s) => (s.target === undefined || visibleTargets(s.target).length > 0) &&
        (s.inspector === undefined || this.inspectorSession?.canShow(s.inspector) !== false));
    if (this.steps.length === 0) return;
    this.wasPlaying = this.app.playing;
    this.index = 0;
    this.build();
    this.show();
  }

  private build(): void {
    // Each replay owns new dimming tiles and its own union outline. Removed
    // nodes from the previous run must never be reused by the new root.
    this.cells.length = 0;
    this.scrim = el("div", { class: "tour-scrim" });
    this.outline = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.outline.setAttribute("class", "tour-ring");
    this.outline.setAttribute("aria-hidden", "true");
    this.outlinePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.outline.append(this.outlinePath);
    this.card = el("div", { class: "tour-card", "aria-live": "polite",
                            "aria-atomic": "true" });
    this.card.tabIndex = -1;
    this.focus = new ModalFocus(this.card, "Guided tour");
    this.root = el("div", { class: "tour-root" }, this.scrim, this.outline, this.card);
    document.body.append(this.root);
    const doc = document as Document & {
      getElementById?: (id: string) => HTMLElement | null;
    };
    this.shell = doc.getElementById?.("app") ?? null;
    this.focus.enter();
    if (this.shell !== null) this.shell.inert = true;
    // capture phase: the tour owns the keyboard while it is up, so its keys
    // never also reach the app's global shortcuts underneath
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.reflow);
    window.addEventListener("scroll", this.reflow, true);
  }

  private go(delta: number): void {
    const next = this.index + delta;
    if (next < 0) return;
    if (next >= this.steps.length) {
      this.finish();
      return;
    }
    this.index = next;
    this.show();
  }

  private show(): void {
    const step = this.steps[this.index];
    step.enter?.(this.app);
    this.revealInspector();
    const last = this.index === this.steps.length - 1;
    let text = (isTouch() && step.touchBody) || step.body;
    if (this.index === 0) {
      text += ` ${countNoun(this.steps.length, "quick stop")} and you are done.`;
    }

    this.card.style.maxHeight = "";
    this.card.replaceChildren();
    this.card.append(
      el("div", { class: "tour-step", text: `${this.index + 1} of ${this.steps.length}` }),
      el("h3", { text: step.title }),
      el("p", { text }));

    const row = el("div", { class: "tour-actions" });
    const skip = el("button", { class: "ghost", text: last ? "" : "Skip" });
    if (!last) {
      skip.addEventListener("click", () => this.finish());
      row.append(skip);
    }
    row.append(el("div", { style: "flex:1" }));
    if (this.index > 0) {
      const back = el("button", { text: "Back" });
      back.addEventListener("click", () => this.go(-1));
      row.append(back);
    }
    const next = el("button", { class: "primary", text: last ? "Get started" : "Next" });
    next.addEventListener("click", () => this.go(1));
    row.append(next);
    this.card.append(row);
    this.place();
    this.card.scrollTop = 0;
    // Long cards start at their heading rather than scrolling immediately
    // to an off-screen Next button. Tab still reaches every action.
    if (this.card.scrollHeight > this.card.clientHeight + 1) this.card.focus({ preventScroll: true });
    else next.focus({ preventScroll: true });
  }

  private revealInspector(): void {
    const section = this.steps[this.index]?.inspector;
    this.inspectorTarget = section ? this.inspectorSession?.reveal(section) ?? null : null;
  }

  /** Dim everything except `holes`, and outline their actual union.
   *
   * The obvious trick - one element with a huge spread box-shadow - can
   * only ever punch a single hole, and a bounding box around several
   * targets swallows whatever sits between them. So the dimming is tiled
   * instead: cut the viewport along every hole edge and fill the cells
   * that no hole covers. With a handful of targets that is a handful of
   * divs, and it is exact.
   *
   * The tiles are pure black inside a container that carries the opacity,
   * rather than each being translucent. Translucent tiles double-darken
   * where they overlap and leave a pale seam where they do not, and no
   * amount of rounding avoids both on a fractional-pixel layout; composited
   * opaque and faded once, a half-pixel overlap is invisible. */
  private paintHoles(holes: Rect[]): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const xs = new Set<number>([0, vw]);
    const ys = new Set<number>([0, vh]);
    for (const r of holes) {
      xs.add(Math.max(0, Math.min(vw, r.x)));
      xs.add(Math.max(0, Math.min(vw, r.x + r.w)));
      ys.add(Math.max(0, Math.min(vh, r.y)));
      ys.add(Math.max(0, Math.min(vh, r.y + r.h)));
    }
    const ux = [...xs].sort((a, b) => a - b);
    const uy = [...ys].sort((a, b) => a - b);

    let used = 0;
    const tile = (x: number, y: number, w: number, h: number): void => {
      let n = this.cells[used];
      if (n === undefined) {
        n = el("div", { class: "tour-tile" });
        this.cells.push(n);
        this.scrim.append(n);
      }
      // half-pixel bleed closes seams; overlap is harmless here
      n.style.cssText = `left:${x - 0.5}px;top:${y - 0.5}px;` +
                        `width:${w + 1}px;height:${h + 1}px`;
      n.hidden = false;
      used++;
    };
    for (let i = 0; i < ux.length - 1; i++) {
      for (let j = 0; j < uy.length - 1; j++) {
        const x = ux[i];
        const y = uy[j];
        const w = ux[i + 1] - x;
        const h = uy[j + 1] - y;
        if (w <= 0 || h <= 0) continue;
        const mx = x + w / 2;
        const my = y + h / 2;
        const inHole = holes.some((r) => mx > r.x && mx < r.x + r.w &&
                                         my > r.y && my < r.y + r.h);
        if (!inHole) tile(x, y, w, h);
      }
    }
    for (let i = used; i < this.cells.length; i++) this.cells[i].hidden = true;

    this.outline.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    this.outlinePath.setAttribute("d", spotlightOutline(holes));
  }

  /** Put the spotlight over the current target and the card beside it.
   *
   * The card is placed on whichever side of the target has room, and is
   * always clamped inside the viewport - a step must never be half
   * off-screen on a small window, which is exactly where the panels it
   * points at are tightest. */
  private place(): void {
    if (this.root === null) return;
    const step = this.steps[this.index];
    let targets = step.target ? visibleTargets(step.target) : [];
    if (this.inspectorTarget?.isConnected) {
      targets = targets.filter(target => target.id !== "inspector" && target.id !== "inspector-handle");
      if (this.inspectorTarget.closest("#inspector")?.classList.contains("mobile-open")) {
        // A phone drawer overlays the scene; spotlight its control rather
        // than swallowing it into the entire canvas behind the drawer.
        targets = targets.filter(target => target.id !== "canvas-wrap");
      }
      targets.push(this.inspectorTarget);
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12; // gap between spotlight and card

    // One hole PER match, not one box around them all. A bounding box over
    // the canvas and the full-width bar beneath it also swallows the side
    // panels between them, which highlights everything and so highlights
    // nothing.
    const pad = 4;
    const holes: Rect[] = [];
    for (const n of targets) {
      const b = n.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      // Keep the complete stroke inside the window, including edge controls.
      const hx = Math.max(2, b.left - pad);
      const hy = Math.max(2, b.top - pad);
      const right = Math.min(vw - 2, b.right + pad), bottom = Math.min(vh - 2, b.bottom + pad);
      if (right > hx && bottom > hy) holes.push({ x: hx, y: hy, w: right - hx, h: bottom - hy });
    }
    this.paintHoles(holes);
    if (holes.length === 0) {
      this.card.style.left = `${Math.round((vw - this.card.offsetWidth) / 2)}px`;
      this.card.style.top = `${Math.round((vh - this.card.offsetHeight) / 2)}px`;
      return;
    }
    // Inspector steps anchor the explanation to the revealed control, so
    // a second large scene spotlight cannot push the card over that control.
    let x = Infinity;
    let y = Infinity;
    let rgt = -Infinity;
    let bot = -Infinity;
    for (const r of this.inspectorTarget ? holes.slice(-1) : holes) {
      if (r.x < x) x = r.x;
      if (r.y < y) y = r.y;
      if (r.x + r.w > rgt) rgt = r.x + r.w;
      if (r.y + r.h > bot) bot = r.y + r.h;
    }
    const w = rgt - x;
    const h = bot - y;

    const cw = this.card.offsetWidth;
    // On narrow/short windows a long explanation must scroll beside the
    // revealed control, rather than covering the very thing it explains.
    // Keep the cap stable during card scrolling so its scroll position is
    // never reset by temporarily expanding it to the full viewport.
    let cap = "";
    if (this.inspectorTarget) {
      const horizontalRoom = x >= cw + M || vw - rgt >= cw + M;
      const available = horizontalRoom ? vh - 2 * M : Math.max(y - 2 * M, vh - bot - 2 * M);
      cap = `${Math.max(80, Math.floor(Math.min(vh - 2 * M, available)))}px`;
    }
    if (this.card.style.maxHeight !== cap) this.card.style.maxHeight = cap;
    const ch = this.card.offsetHeight;
    const below = vh - (y + h);
    let cx: number;
    let cy: number;
    if (below >= ch + M) {              // under it
      cx = x + w / 2 - cw / 2;
      cy = y + h + M;
    } else if (y >= ch + M) {           // over it
      cx = x + w / 2 - cw / 2;
      cy = y - ch - M;
    } else if (x >= cw + M) {           // to its left
      cx = x - cw - M;
      cy = y + h / 2 - ch / 2;
    } else {                            // to its right
      cx = x + w + M;
      cy = y + h / 2 - ch / 2;
    }
    this.card.style.left = `${Math.round(Math.max(M, Math.min(vw - cw - M, cx)))}px`;
    this.card.style.top = `${Math.round(Math.max(M, Math.min(vh - ch - M, cy)))}px`;
  }

  /** Close the tour and remember not to open it again. */
  finish(): void {
    if (this.root === null) return;
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.reflow);
    window.removeEventListener("scroll", this.reflow, true);
    if (this.shell !== null) this.shell.inert = false;
    this.inspectorSession?.restore();
    this.inspectorSession = null;
    this.inspectorTarget = null;
    this.focus.exit();
    this.root.remove();
    this.root = null;
    this.shell = null;
    // Release the pooled tiles with their removed root.
    this.cells.length = 0;
    this.app.playing = this.wasPlaying; // leave playback as we found it
    this.app.settings[TOUR_KEY] = true;
    this.app.saveSettings();
  }
}
