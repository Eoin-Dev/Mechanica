/** Modal overlays: the preset library / saved scenes, and help & shortcuts. */
import { App } from "../app";
import { CATEGORIES, PRESETS } from "../scene/presets";
import * as snap from "../scene/snapshot";
import { button, el } from "./dom";
import { ICONS } from "./icons";

// ------------------------------------------------------------------ library
export class Library {
  visible = false;
  private app: App;
  private root: HTMLElement;
  private category = "All";
  private grid!: HTMLElement;
  private scenesEl!: HTMLElement;
  private chips!: HTMLElement;

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
    this.renderCards();
    this.renderScenes();
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
    const app = this.app;
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: "Library" }));
    header.append(button("Save current scene", () => {
      const name = prompt("Scene name:",
        `scene ${new Date().toISOString().slice(0, 10)}`);
      if (name) {
        snap.saveScene(app.world, name);
        app.toast(`Saved scene '${name}'`);
        this.renderScenes();
      }
    }, { icon: ICONS.save }).root);
    header.append(button("Import .json", async () => {
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
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);

    const body = el("div", { class: "overlay-body" });
    this.chips = el("div", { class: "cat-chips" });
    this.grid = el("div", { class: "card-grid" });
    this.scenesEl = el("div");
    body.append(this.chips, this.grid,
                el("h3", { text: "Saved scenes",
                           style: "margin:18px 0 6px;font-size:14px" }),
                this.scenesEl);

    this.root.append(el("div", { class: "overlay-panel" }, header, body));
    this.renderChips();
  }

  private renderChips(): void {
    this.chips.replaceChildren();
    for (const cat of CATEGORIES) {
      const b = el("button", { text: cat });
      if (cat === this.category) b.classList.add("active");
      b.addEventListener("click", () => {
        this.category = cat;
        this.renderChips();
        this.renderCards();
      });
      this.chips.append(b);
    }
  }

  private renderCards(): void {
    this.grid.replaceChildren();
    for (const preset of PRESETS) {
      if (this.category !== "All" && preset.category !== this.category) continue;
      const card = el("div", { class: "preset-card" },
        el("div", { class: "cat", text: preset.category }),
        el("h3", { text: preset.name }),
        el("p", { text: preset.description }));
      card.addEventListener("click", () => {
        this.app.loadPreset(preset);
        this.close();
      });
      this.grid.append(card);
    }
  }

  private renderScenes(): void {
    const app = this.app;
    this.scenesEl.replaceChildren();
    const names = snap.listScenes();
    if (names.length === 0) {
      this.scenesEl.append(el("div", { class: "faint",
        text: "No saved scenes yet. Ctrl+S saves the current scene here " +
              "(stored in this browser); Export downloads it as a file." }));
      return;
    }
    for (const name of names) {
      const row = el("div", { class: "scene-row" },
        el("span", { class: "name", text: name }));
      row.append(button("Load", () => {
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
      }).root);
      row.append(button("Export", () => {
        const world = snap.loadScene(name);
        if (world !== null) snap.downloadScene(world, name);
      }, { icon: ICONS.download, tooltip: "Download as a .json file" }).root);
      row.append(button("", () => {
        snap.deleteScene(name);
        this.renderScenes();
      }, { icon: ICONS.trash, style: "ghost", tooltip: "Delete this saved scene" }).root);
      this.scenesEl.append(row);
    }
  }
}

// --------------------------------------------------------------------- help
const SHORTCUT_SECTIONS: Array<[string, Array<[string, string]>]> = [
  ["Playback", [
    ["Space", "play / pause"],
    [". / ,", "step forward / back one frame"],
    ["Ctrl+R", "reset to the initial state"],
    ["+ / -", "double / halve the speed"],
    ["0", "reset the speed to 1x"],
  ]],
  ["Tools", [
    ["V", "select"],
    ["H", "pan"],
    ["B / A", "add body / anchor"],
    ["W", "draw wall (Shift snaps the angle)"],
    ["R / E / S", "connect rod / string / spring"],
    ["X", "eraser"],
    ["Esc", "cancel a pending link or wall; clear selection"],
  ]],
  ["Editing", [
    ["Ctrl+Z / Ctrl+Y", "undo / redo"],
    ["Ctrl+D", "duplicate the selection"],
    ["Del", "delete the selection"],
    ["Ctrl+C / Ctrl+V", "copy / paste body properties"],
    ["Arrows", "nudge selected bodies"],
    ["K", "lock / unlock selected bodies"],
    ["N", "snap to grid"],
    ["Ctrl+S", "save the scene (browser storage)"],
  ]],
  ["View & analysis", [
    ["F / Shift+F", "zoom to fit / auto-fit camera"],
    ["C", "follow the selected body"],
    ["T", "motion trails"],
    ["D", "velocity vectors"],
    ["G", "broadphase debug grid"],
    ["1 / 2 / 3", "energy / momentum / phase graph"],
    ["Scroll / right-drag", "zoom at cursor / pan"],
    ["Tab", "hide / show the inspector"],
    ["L", "library"],
    ["F1", "this help"],
  ]],
  ["Mouse & touch", [
    ["drag a body", "move it (throw it while playing)"],
    ["hold a body still", "pin it while everything collides with it"],
    ["drag the green arrow", "set a body's velocity exactly"],
    ["right-drag a body", "aim its velocity vector"],
    ["drag empty space", "box select"],
    ["pinch (touch)", "zoom and pan"],
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
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: "Help & shortcuts" }));
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);
    const cols = el("div", { class: "help-cols" });
    for (const [title, rows] of SHORTCUT_SECTIONS) {
      const col = el("div", {}, el("h3", { text: title }));
      for (const [keys, what] of rows) {
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
