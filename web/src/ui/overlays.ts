/** Modal overlays: the library (example presets + saved scenes), and help. */
import { App } from "../app";
import { CATEGORIES, PRESETS } from "../scene/presets";
import * as snap from "../scene/snapshot";
import { button, el, isTouch } from "./dom";
import { ICONS } from "./icons";

// ------------------------------------------------------------------ library
type LibraryTab = "Examples" | "My scenes";

export class Library {
  visible = false;
  private app: App;
  private root: HTMLElement;
  private tab: LibraryTab = "Examples";
  private category = "All";
  private tabBtns = new Map<LibraryTab, HTMLButtonElement>();
  private content!: HTMLElement;

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    this.build();
  }

  open(): void {
    this.visible = true;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  private build(): void {
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: "Library" }));
    const tabs = el("div", { class: "tabs", style: "border:none;flex:none;width:280px" });
    for (const t of ["Examples", "My scenes"] as const) {
      const b = el("button", { text: t });
      b.addEventListener("click", () => {
        this.tab = t;
        this.render();
      });
      this.tabBtns.set(t, b);
      tabs.append(b);
    }
    header.append(tabs);
    header.append(el("div", { style: "flex:1" }));
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);

    this.content = el("div", { class: "overlay-body" });
    this.root.append(el("div", { class: "overlay-panel" }, header, this.content));
  }

  private render(): void {
    for (const [t, b] of this.tabBtns) b.classList.toggle("active", t === this.tab);
    this.content.replaceChildren();
    if (this.tab === "Examples") this.renderExamples();
    else this.renderScenes();
  }

  // ------------------------------------------------------------- examples
  private renderExamples(): void {
    const chips = el("div", { class: "cat-chips" });
    for (const cat of CATEGORIES) {
      const b = el("button", { text: cat });
      if (cat === this.category) b.classList.add("active");
      b.addEventListener("click", () => {
        this.category = cat;
        this.render();
      });
      chips.append(b);
    }
    const grid = el("div", { class: "card-grid" });
    // Descriptions are clamped to a few lines; where one is truncated we add a
    // "Show more" toggle (mouse- or keyboard-activated) to reveal the full text
    // without loading the preset. Whether it's needed can only be measured once
    // the cards are laid out, so collect them and check after appending.
    const clampable: Array<{ desc: HTMLElement; card: HTMLElement }> = [];
    for (const preset of PRESETS) {
      if (this.category !== "All" && preset.category !== this.category) continue;
      const desc = el("p", { text: preset.description });
      const card = el("div", { class: "preset-card" },
        el("div", { class: "cat", text: preset.category }),
        el("h3", { text: preset.name }),
        desc);
      card.addEventListener("click", () => {
        this.app.loadPreset(preset);
        this.close();
      });
      grid.append(card);
      clampable.push({ desc, card });
    }
    this.content.append(chips, grid);

    for (const { desc, card } of clampable) {
      if (desc.scrollHeight <= desc.clientHeight + 1) continue; // fully visible
      const more = el("button", { class: "card-more", text: "Show more" });
      more.addEventListener("click", (e) => {
        e.stopPropagation(); // don't load the preset when toggling the text
        const open = card.classList.toggle("expanded");
        more.textContent = open ? "Show less" : "Show more";
      });
      card.append(more);
    }
  }

  // ----------------------------------------------------------- saved scenes
  private renderScenes(): void {
    const app = this.app;
    const actions = el("div", { class: "cat-chips" });
    actions.append(button("Save current scene", () => {
      const name = prompt("Scene name:",
        `Scene ${new Date().toISOString().slice(0, 10)}`);
      if (name) {
        const saved = snap.saveScene(app.world, name);
        app.toast(`Saved scene '${saved}'`);
        this.render();
      }
    }, { icon: ICONS.save }).root);
    actions.append(button("Import .json", async () => {
      const result = await snap.uploadScene();
      if (result === null) {
        app.toast("Could not read that scene file");
        return;
      }
      app.replaceWorld(result.world);
      app.undoStack.reset(app.world);
      app.ensureInitial();
      app.zoomToFit();
      app.toast(`Loaded scene '${result.name}'`);
      this.close();
    }, { icon: ICONS.upload,
         tooltip: "Load a scene file saved from this app or the desktop version" }).root);
    this.content.append(actions);

    const names = snap.listScenes();
    if (names.length === 0) {
      this.content.append(el("div", { class: "faint",
        style: "margin-top:14px",
        text: (isTouch()
                ? "No saved scenes yet. The button above saves the "
                : "No saved scenes yet. Ctrl+S (or the button above) saves the ") +
              "current scene here, stored in this browser. Export downloads " +
              "a scene as a file the desktop app can read too." }));
      return;
    }

    const grid = el("div", { class: "card-grid" });
    for (const name of names) {
      const desc = snap.sceneDescription(name);
      const card = el("div", { class: "preset-card scene-card" },
        el("div", { class: "cat", text: "Saved scene" }),
        el("h3", { text: name }));
      if (desc) card.append(el("p", { text: desc }));

      const bar = el("div", { class: "card-actions" });
      const stop = (fn: () => void) => (e: Event) => {
        e.stopPropagation(); // buttons must not trigger the card's load
        fn();
      };
      const mkBtn = (icon: string, tooltip: string, fn: () => void,
                     danger = false): HTMLElement => {
        const b = el("button", { class: `ghost icon${danger ? " danger" : ""}`,
                                 title: tooltip });
        b.insertAdjacentHTML("beforeend", icon);
        b.addEventListener("click", stop(fn));
        return b;
      };
      bar.append(mkBtn(ICONS.rename, "Rename", () => {
        const newName = prompt("Rename scene:", name);
        if (!newName || newName === name) return;
        const saved = snap.renameScene(name, newName);
        if (saved === null) app.toast("A scene with that name already exists");
        else app.toast(`Renamed to '${saved}'`);
        this.render();
      }));
      bar.append(mkBtn(ICONS.describe, desc ? "Edit description" : "Add description", () => {
        const text = prompt("Description (empty to remove):", desc);
        if (text === null) return;
        snap.setSceneDescription(name, text);
        this.render();
      }));
      bar.append(mkBtn(ICONS.download, "Download as a .json file", () => {
        const world = snap.loadScene(name);
        if (world !== null) snap.downloadScene(world, name);
      }));
      bar.append(mkBtn(ICONS.trash, "Delete this saved scene", () => {
        if (!confirm(`Delete saved scene '${name}'?`)) return;
        snap.deleteScene(name);
        this.render();
      }, true));
      card.append(bar);

      card.addEventListener("click", () => {
        const world = snap.loadScene(name);
        if (world === null) {
          app.toast(`Could not load '${name}'`);
          return;
        }
        app.replaceWorld(world);
        app.undoStack.reset(app.world);
        app.ensureInitial();
        app.zoomToFit();
        app.toast(`Loaded scene '${name}'`);
        this.close();
      });
      grid.append(card);
    }
    this.content.append(grid);
  }
}

// --------------------------------------------------------------------- help
/** Rows tagged "pc" need a keyboard or mouse and are dropped on touch
 * devices; untagged rows work everywhere. Keyboard-shortcut sections are
 * tagged as a whole. */
type HelpRow = [string, string] | [string, string, "pc"];
const SHORTCUT_SECTIONS: Array<[string, HelpRow[], "pc"?]> = [
  ["Playback", [
    ["Space", "Play / pause"],
    [". / ,", "Step forward / back one frame"],
    ["Ctrl+R", "Reset to the initial state"],
    ["+ / -", "Double / halve the speed"],
    ["0", "Reset the speed to 1x"],
  ], "pc"],
  ["Tools", [
    ["V", "Select"],
    ["H", "Pan"],
    ["B / A", "Add body / anchor"],
    ["W", "Draw wall (Shift snaps the angle)"],
    ["R / E / S", "Connect rod / string / spring"],
    ["X", "Eraser"],
    ["Esc", "Cancel a pending link or wall; clear selection"],
  ], "pc"],
  ["Editing", [
    ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
    ["Ctrl+D", "Duplicate the selection"],
    ["Del", "Delete the selection"],
    ["Ctrl+C / Ctrl+V", "Copy / paste body properties"],
    ["Arrows", "Nudge selected bodies"],
    ["K", "Lock / unlock selected bodies"],
    ["N", "Snap to grid"],
    ["Ctrl+S", "Save the scene (browser storage)"],
  ], "pc"],
  ["View & analysis", [
    ["F / Shift+F", "Zoom to fit / auto-fit camera"],
    ["C", "Follow the selected body"],
    ["T", "Motion trails"],
    ["D", "Velocity vectors"],
    ["G", "Broadphase debug grid"],
    ["1 / 2 / 3", "Energy / momentum / phase graph"],
    ["Scroll / right-drag", "Zoom at cursor / pan"],
    ["Tab", "Hide / show the inspector"],
    ["L", "Library"],
    ["F1", "This help"],
  ], "pc"],
  ["Mouse & touch", [
    ["Drag a body", "Move it (throw it while playing)"],
    ["Hold a body still", "Pin it while everything collides with it"],
    ["Drag the green arrow", "Set a body's velocity exactly"],
    ["Right-drag a body", "Aim its velocity vector", "pc"],
    ["Drag empty space", "Box select"],
    ["Pinch (touch)", "Zoom and pan"],
  ]],
];

export class Help {
  visible = false;
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    // touch devices (phones and tablets) have no keyboard or mouse: hide
    // the shortcut sections and mouse-only rows, keep the touch gestures
    const touch = isTouch();
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: touch ? "Help" : "Help & shortcuts" }));
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);
    const cols = el("div", { class: "help-cols" });
    for (const [title, rows, sectionTag] of SHORTCUT_SECTIONS) {
      if (touch && sectionTag === "pc") continue;
      const col = el("div", {},
        el("h3", { text: touch && title === "Mouse & touch" ? "Touch" : title }));
      for (const [keys, what, rowTag] of rows) {
        if (touch && rowTag === "pc") continue;
        col.append(el("div", { class: "shortcut-row" },
          el("span", { class: "keys", text: keys }),
          el("span", { class: "what", text: what })));
      }
      cols.append(col);
    }
    const about = el("div", { class: "faint", style:
      "margin-top:16px;font-size:12px;line-height:1.5" });
    about.textContent =
      "Mechanica is a 2D physics lab: rigid discs with rotation, walls, " +
      "rods, strings, springs, N-body gravity, drag, drivers and custom " +
      "force fields, integrated with symplectic solvers. Everything is in " +
      "SI units. All simulation runs locally in your browser.";
    const body = el("div", { class: "overlay-body" }, cols, about);
    root.append(el("div", { class: "overlay-panel" }, header, body));
  }

  open(): void {
    this.visible = true;
    this.root.hidden = false;
  }

  close(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }
}
