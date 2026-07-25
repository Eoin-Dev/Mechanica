/** First-run guided tour.
 *
 * Mechanica opens on a canvas with nine tools, three inspector tabs and a
 * library of 47 examples, and previously said nothing about any of it - the
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
import { el, isTouch } from "./dom";

/** One stop on the tour.
 *
 * `target` is a CSS selector for the element to spotlight; omit it for a
 * centred card with no anchor. `enter` runs when the step is shown - used
 * to put the app in a state the step is talking about (running, paused),
 * never to change what the user has built.
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
          "browser. Six quick stops and you are done.",
  },
  {
    target: "#canvas-wrap",
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
    body: "Drag a body with it running and you throw it; hold it still and " +
          "it stays pinned under your cursor while everything else piles " +
          "into it. Drag the green arrow on a selected body to set its " +
          "velocity exactly.",
    touchBody: "Drag a body with it running and you throw it; hold it still " +
               "and it stays pinned under your finger while everything else " +
               "piles into it. Drag the green arrow on a selected body to " +
               "set its velocity exactly.",
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
    target: "#inspector",
    title: "Change anything, measure everything",
    body: "Select an object and every property is here to edit: mass, " +
          "radius, bounce, friction, colour. The World tab holds gravity, " +
          "air drag and the solver; View turns on velocity arrows, motion " +
          "trails, the centre of mass and the live energy and momentum " +
          "graphs.",
  },
  {
    target: "#toolbar",
    title: "Start from a worked example",
    body: "The Library has 47 ready-made simulations - orbits, pendulums, " +
          "collisions, gases, chaos, soft bodies - each with a note on what " +
          "it demonstrates. It is the fastest way in: load one, run it, " +
          "then take it apart. The gear beside it holds settings, and help " +
          "with every shortcut.",
  },
];

const TOUR_KEY = "tour_done";

export class Tour {
  private app: App;
  private root: HTMLElement | null = null;
  private spot!: HTMLElement;
  private card!: HTMLElement;
  private index = 0;
  private wasPlaying = false;
  private steps: Step[] = [];
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.finish();
    else if (e.key === "ArrowRight" || e.key === "Enter") this.go(1);
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
    this.steps = STEPS.filter(
      (s) => s.target === undefined || document.querySelector(s.target) !== null);
    if (this.steps.length === 0) return;
    this.wasPlaying = this.app.playing;
    this.index = 0;
    this.build();
    this.show();
  }

  private build(): void {
    this.spot = el("div", { class: "tour-spot" });
    this.card = el("div", { class: "tour-card", role: "dialog",
                            "aria-modal": "true", "aria-label": "Guided tour" });
    this.root = el("div", { class: "tour-root" }, this.spot, this.card);
    document.body.append(this.root);
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
    const text = (isTouch() && step.touchBody) || step.body;

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

  /** Put the spotlight over the current target and the card beside it.
   *
   * The card is placed on whichever side of the target has room, and is
   * always clamped inside the viewport - a step must never be half
   * off-screen on a small window, which is exactly where the panels it
   * points at are tightest. */
  private place(): void {
    if (this.root === null) return;
    const step = this.steps[this.index];
    const target = step.target ? document.querySelector(step.target) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12; // gap between spotlight and card

    if (target === null) {
      this.spot.style.display = "none";
      this.card.style.left = `${Math.round((vw - this.card.offsetWidth) / 2)}px`;
      this.card.style.top = `${Math.round((vh - this.card.offsetHeight) / 2)}px`;
      return;
    }
    const r = target.getBoundingClientRect();
    // inset slightly so the ring hugs a full-height panel instead of
    // bleeding off the window edge
    const pad = 4;
    const x = Math.max(0, r.left - pad);
    const y = Math.max(0, r.top - pad);
    const w = Math.min(vw, r.right + pad) - x;
    const h = Math.min(vh, r.bottom + pad) - y;
    this.spot.style.display = "";
    this.spot.style.left = `${x}px`;
    this.spot.style.top = `${y}px`;
    this.spot.style.width = `${w}px`;
    this.spot.style.height = `${h}px`;

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
    this.root.remove();
    this.root = null;
    this.app.playing = this.wasPlaying; // leave playback as we found it
    this.app.settings[TOUR_KEY] = true;
    this.app.saveSettings();
  }
}
