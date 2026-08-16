/** First-run guided tour.
 *
 * Mechanica opens on a canvas with nine tools, three inspector tabs and a
 * library of 48 examples, and previously said nothing about any of it - the
 * only orientation was a shortcut table behind F1, which answers "what key
 * does X" and never "what is this and what do I do first". `tour_done` had
 * been sitting in the settings type since the port with nothing behind it.
 *
 * The tour spotlights real controls in place rather than describing them in
 * the abstract, and each step is one idea with one thing to look at. It runs
 * once automatically, can be skipped at any point, and can be replayed from
 * Settings. It never edits the user's scene: it plays and pauses the
 * simulation to show motion, and restores the play state it found.
 */
import type { App } from "../app";
import { ModalFocus, countNoun, el, isTouch } from "./dom";

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
}

export const STEPS: Step[] = [
  {
    title: "Welcome to Mechanica",
    body: "A physics sandbox: build mechanical systems, run them, and " +
          "measure what they do. Everything is real SI units - metres, " +
          "kilograms, seconds, newtons - and everything runs in this " +
          "browser.",
  },
  {
    // the bar below the canvas is half of what this step describes
    target: "#canvas-wrap, #hintbar",
    title: "The scene",
    body: "This is the world. Scroll to zoom at the cursor, right-drag or " +
          "middle-drag to pan. The bar at the bottom always shows where " +
          "your cursor is in metres, how many objects exist, and how far " +
          "the total energy has drifted - a running check on the solver.",
    touchBody: "This is the world. Pinch with two fingers to zoom and pan. " +
               "The bar at the bottom shows how many objects exist and how " +
               "far the total energy has drifted - a running check on the " +
               "solver.",
  },
  {
    target: "#toolbar",
    title: "Run it",
    body: "Press play - or the spacebar - and the simulation starts. The " +
          "arrows step one frame at a time, forwards or back, which is how " +
          "you catch what happens during a collision. The clock is " +
          "editable: type a time and the scene is re-simulated to it.",
    touchBody: "Press play and the simulation starts. The arrows step one " +
               "frame at a time, forwards or back, which is how you catch " +
               "what happens during a collision. The clock is editable: " +
               "type a time and the scene is re-simulated to it.",
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
    body: "Bodies and anchors, walls, and three ways to connect things: a " +
          "rigid rod, a string, a spring. Click two bodies to link them - " +
          "or click empty space and the anchor or body you need is created " +
          "for you, so a pendulum takes two clicks.",
    touchBody: "Bodies and anchors, walls, and three ways to connect " +
               "things: a rigid rod, a string, a spring. Tap two bodies to " +
               "link them - or tap empty space and the anchor or body you " +
               "need is created for you, so a pendulum takes two taps.",
    enter: (app) => { app.playing = false; },
  },
  {
    // On a phone the inspector is a closed drawer, so there is nothing to
    // point at - but the handle that opens it is right there, and is
    // exactly what a phone user needs to be shown. Whichever of the two is
    // visible gets the ring; the other is skipped as hidden.
    target: "#inspector, #inspector-handle",
    title: "Change anything, measure everything",
    body: "Select an object and every property is here to edit: mass, " +
          "radius, bounce, friction, colour. The World tab holds gravity, " +
          "air drag and the solver; View turns on velocity arrows, motion " +
          "trails, the centre of mass and the live energy and momentum " +
          "graphs.",
    touchBody: "Tap the tab on the right edge to slide the panel open. " +
               "Select an object and every property is there to edit: mass, " +
               "radius, bounce, friction, colour. The World tab holds " +
               "gravity and air drag; View turns on velocity arrows, motion " +
               "trails and the live energy and momentum graphs.",
  },
  {
    // Force fields are the most distinctive thing here and the steepest
    // cliff: they sit at the bottom of the World tab, so nobody finds them
    // by accident. Pointing at the panel is enough - the step's job is to
    // establish that they exist and that there is a guide for them.
    target: "#inspector, #inspector-handle",
    title: "Write your own physics",
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
    body: "The Library has 48 ready-made simulations - orbits, pendulums, " +
          "collisions, gases, chaos, soft bodies - each with a note on what " +
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
  private rings: HTMLElement[] = []; // pooled outlines, one per hole
  private card!: HTMLElement;
  private focus!: ModalFocus;
  private shell: HTMLElement | null = null;
  private index = 0;
  private wasPlaying = false;
  private steps: Step[] = [];
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.finish();
    else if (e.key === "ArrowRight") this.go(1);
    else if (e.key === "ArrowLeft") this.go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  private reflow = (): void => this.place();

  constructor(app: App) {
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
    // steps whose target is missing (a panel hidden on this viewport) are
    // dropped rather than shown pointing at nothing
    // Same visibility test place() uses, so the two can never disagree:
    // existing in the DOM is not enough, since a panel that is collapsed or
    // below the phone breakpoint is present but has nothing to ring. A step
    // with no visible target would otherwise show as an unanchored card
    // describing something the reader cannot see.
    this.steps = STEPS.filter(
      (s) => s.target === undefined || visibleTargets(s.target).length > 0);
    if (this.steps.length === 0) return;
    this.wasPlaying = this.app.playing;
    this.index = 0;
    this.build();
    this.show();
  }

  private build(): void {
    // The pools belong to the scrim and root built below, so they start
    // empty for every run. Carrying them across meant a replay - from
    // Settings or from Help, the only ways to see the tour twice - reused
    // tiles and rings that were still parented to the PREVIOUS root, which
    // finish() had already removed from the document. Nothing was appended
    // to the new scrim, so the second showing had no dimming and no
    // highlight ring at all: just a card floating over an undimmed page.
    this.cells.length = 0;
    this.rings.length = 0;
    this.scrim = el("div", { class: "tour-scrim" });
    this.card = el("div", { class: "tour-card", "aria-live": "polite",
                            "aria-atomic": "true" });
    this.focus = new ModalFocus(this.card, "Guided tour");
    this.root = el("div", { class: "tour-root" }, this.scrim, this.card);
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
    const last = this.index === this.steps.length - 1;
    let text = (isTouch() && step.touchBody) || step.body;
    if (this.index === 0) {
      text += ` ${countNoun(this.steps.length, "quick stop")} and you are done.`;
    }

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
    next.focus();
  }

  /** Dim everything except `holes`, and ring each one.
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

    for (let i = 0; i < Math.max(holes.length, this.rings.length); i++) {
      let ring = this.rings[i];
      if (ring === undefined) {
        ring = el("div", { class: "tour-ring" });
        this.rings.push(ring);
        this.root!.insertBefore(ring, this.card);
      }
      const r = holes[i];
      if (r === undefined) {
        ring.hidden = true;
        continue;
      }
      ring.hidden = false;
      ring.style.cssText =
        `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    }
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
    const targets = step.target ? visibleTargets(step.target) : [];
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
      const hx = Math.max(0, b.left - pad);
      const hy = Math.max(0, b.top - pad);
      holes.push({ x: hx, y: hy,
                   w: Math.min(vw, b.right + pad) - hx,
                   h: Math.min(vh, b.bottom + pad) - hy });
    }
    this.paintHoles(holes);
    if (holes.length === 0) {
      this.card.style.left = `${Math.round((vw - this.card.offsetWidth) / 2)}px`;
      this.card.style.top = `${Math.round((vh - this.card.offsetHeight) / 2)}px`;
      return;
    }
    // the card is placed against the union, so it clears every hole
    let x = Infinity;
    let y = Infinity;
    let rgt = -Infinity;
    let bot = -Infinity;
    for (const r of holes) {
      if (r.x < x) x = r.x;
      if (r.y < y) y = r.y;
      if (r.x + r.w > rgt) rgt = r.x + r.w;
      if (r.y + r.h > bot) bot = r.y + r.h;
    }
    const w = rgt - x;
    const h = bot - y;

    const cw = this.card.offsetWidth;
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
    this.focus.exit();
    this.root.remove();
    this.root = null;
    this.shell = null;
    // drop the pooled tiles/rings with the root that owned them, so they
    // cannot outlive it (build() clears these too - this keeps the removed
    // subtree collectable in the meantime)
    this.cells.length = 0;
    this.rings.length = 0;
    this.app.playing = this.wasPlaying; // leave playback as we found it
    this.app.settings[TOUR_KEY] = true;
    this.app.saveSettings();
  }
}
