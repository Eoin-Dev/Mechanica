/** Modal overlays: the library (example presets + saved scenes), and help. */
import { App } from "../app";
import { CATEGORIES, PRESETS } from "../scene/presets";
import * as snap from "../scene/snapshot";
import { Control, ModalFocus, button, checkbox, el, isTouch, segmented } from "./dom";
import { ICONS } from "./icons";
import { ThemeName, css, defaultAccent } from "./theme";

// ------------------------------------------------------------------ library
type LibraryTab = "Examples" | "My scenes";

export class Library {
  visible = false;
  private app: App;
  private root: HTMLElement;
  private focus!: ModalFocus;
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
    this.focus.enter();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.focus.exit();
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
    const panel = el("div", { class: "overlay-panel" }, header, this.content);
    this.focus = new ModalFocus(panel, "Library");
    this.root.append(panel);
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
      if (!name) return;
      // Names are sanitized before use, so "Run #1" and "Run 1" land on the
      // same key: without this the second save replaced the first with no
      // warning and no way back.
      if (snap.sceneExists(name) &&
          !confirm(`A saved scene called '${name}' already exists. Replace it?`)) {
        return;
      }
      try {
        const saved = snap.saveScene(app.world, name);
        app.toast(`Saved scene '${saved}'`);
        this.render();
      } catch (exc) {
        app.toast(exc instanceof snap.SceneSaveError ? exc.message
                                                     : "Could not save the scene");
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
    }, { icon: ICONS.import,
         tooltip: "Load a .json scene saved from this app or the desktop " +
                  "version." }).root);
    this.content.append(actions);

    const names = snap.listScenes();
    if (names.length === 0) {
      this.content.append(el("div", { class: "faint",
        style: "margin-top:14px",
        text: (isTouch()
                ? "No saved scenes yet. The button above saves the "
                : "No saved scenes yet. Ctrl+S (or the button above) saves the ") +
              "current scene here, stored in this browser." }));
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

// ----------------------------------------------------------------- settings
const THEME_LABELS: Array<[string, ThemeName]> = [
  ["Void", "void"], ["Dark", "dark"], ["Light", "light"],
  ["Original", "original"],
];

/** Hand-picked UI accents (a good purple included, per popular demand).
 * The theme-default swatch already shows the classic blue, so the blue
 * preset here is a distinctly darker midnight blue. */
const ACCENT_PRESETS: string[] = [
  "#781fb7", // deep purple - the red's saturation/darkness, in violet
  "#8b5cf6", // violet
  "#24427c", // midnight blue
  "#2fb4a8", // teal
  "#4caf72", // green
  "#e0964b", // amber
  "#e06c8a", // pink
  "#b81f1f", // visceral red - the hard opposite of the dark blue
];

export class SettingsPanel {
  visible = false;
  private root: HTMLElement;
  private controls: Control[] = [];
  private focus: ModalFocus;

  constructor(app: App, root: HTMLElement, openHelp: () => void,
              startTour: () => void) {
    this.root = root;
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: "Settings" }));
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);
    const body = el("div", { class: "overlay-body settings-grid" });
    // Settings are grouped into cards laid out in columns rather than one
    // long narrow list.
    //
    // House style for every description in the app, here and in the
    // Inspector: the tooltip is ONE sentence saying what the control does.
    // The note below it adds only what the tooltip cannot - the meaning of
    // each choice, or what the setting costs - in at most two short
    // sentences. A recommendation is given only where one option is
    // genuinely better for accuracy or performance, never for a matter of
    // taste, and is written as "Recommended: Enabled." at the front so it
    // can be read without reading the rest.
    let current: HTMLElement = body;
    const group = (title: string): void => {
      current = el("div", { class: "settings-group" },
                    el("div", { class: "section", text: title }));
      body.append(current);
    };
    const add = (c: Control): void => {
      this.controls.push(c);
      current.append(c.root);
    };
    const note = (text: string): void => {
      current.append(el("div", { class: "faint settings-note", text }));
    };
    const label = (text: string): void => {
      current.append(el("div", { class: "dim settings-label", text }));
    };

    group("Appearance");
    add(segmented(THEME_LABELS.map(([lbl]) => lbl),
      () => THEME_LABELS.find(([, t]) => t === (app.settings.theme ?? "dark"))![0],
      (v) => {
        app.settings.theme = THEME_LABELS.find(([lbl]) => lbl === v)![1];
        app.saveSettings();
        app.applyUiSettings();
      }, "Colour theme for the interface and the canvas."));
    note("Void: near-black, showing motion trails at their brightest. " +
         "Dark: the default. Light: for bright rooms and projectors. " +
         "Original: the classic blue-tinted dark palette.");

    // accent colour: preset swatch circles + a custom picker. UI chrome
    // and highlights only - physics object colours are never touched.
    label("Accent colour");
    const swatchRow = el("div", { class: "swatch-row" });
    const accentNote = el("div", { class: "faint settings-note",
      text: "Highlight colour for buttons, selection outlines and graph " +
            "lines. Object colours are set per body in the Inspector and " +
            "are not affected." });
    const applyAccent = (hex: string | null): void => {
      if (hex === null) delete app.settings.accent;
      else app.settings.accent = hex;
      app.saveSettings();
      app.applyUiSettings();
      rebuildSwatches();
    };

    // Custom-colour popover: the native picker only stages a colour (its
    // own swatch shows the preview); NOTHING is applied or saved until
    // Create - dragging through the colour field can no longer spray
    // intermediate colours into the saved list, and Cancel backs out.
    const popover = el("div", { class: "accent-popover" });
    popover.hidden = true;
    const colorInput = el("input", { type: "color",
                                     title: "Pick a colour (hex supported)" });
    const createBtn = button("Create", () => {
      const hex = colorInput.value.toLowerCase();
      if (!ACCENT_PRESETS.includes(hex)) {
        const customs = (app.settings.custom_accents ?? []).filter((h) => h !== hex);
        customs.push(hex);
        while (customs.length > 6) customs.shift(); // keep the last six
        app.settings.custom_accents = customs;
      }
      popover.hidden = true;
      applyAccent(hex);
    }, { style: "primary" });
    const cancelBtn = button("Cancel", () => { popover.hidden = true; });
    popover.append(colorInput, createBtn.root, cancelBtn.root);

    const rebuildSwatches = (): void => {
      swatchRow.replaceChildren();
      const current = app.settings.accent ?? null;
      const mkSwatch = (hex: string | null, tip: string, colour: string,
                        deletable = false): void => {
        const b = el("button", { class: "swatch", title: tip });
        b.append(el("span", { class: "dot", style: `background:${colour}` }));
        if (hex === current) b.classList.add("active");
        b.addEventListener("click", () => applyAccent(hex));
        if (deletable) {
          const x = el("span", { class: "swatch-x", text: "×",
                                 title: "Remove this saved colour" });
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            app.settings.custom_accents =
              (app.settings.custom_accents ?? []).filter((h) => h !== hex);
            // deleting the colour in use falls back to the theme default
            applyAccent(app.settings.accent === hex ? null
                                                    : app.settings.accent ?? null);
          });
          b.append(x);
        }
        swatchRow.append(b);
      };
      mkSwatch(null, "Theme default",
        css(defaultAccent(app.settings.theme ?? "dark")));
      for (const hex of ACCENT_PRESETS) mkSwatch(hex, hex, hex);
      for (const hex of app.settings.custom_accents ?? []) {
        if (!ACCENT_PRESETS.includes(hex)) {
          mkSwatch(hex, `${hex} (custom)`, hex, true);
        }
      }
      const addBtn = el("button", { class: "swatch-add", text: "+",
                                    title: "Create a custom colour" });
      addBtn.addEventListener("click", () => {
        colorInput.value = app.settings.accent ?? "#8b5cf6";
        popover.hidden = false;
      });
      swatchRow.append(addBtn);
    };
    this.controls.push({ root: swatchRow, refresh: () => {
      popover.hidden = true; // reopening settings starts with it closed
      rebuildSwatches();
    } });
    rebuildSwatches();
    current.append(swatchRow, accentNote, popover);

    add(checkbox("Dyslexia-friendly font",
      () => app.settings.dyslexic_font ?? false,
      (v) => {
        app.settings.dyslexic_font = v;
        app.saveSettings();
        app.applyUiSettings();
      }, "Use the OpenDyslexic typeface for interface text."));
    note("Weights the bottom of each letter so similar shapes (b/d, p/q) " +
         "are easier to tell apart. Interface text only, not the canvas.");

    label("Font size");
    add(segmented(["90%", "100%", "110%", "120%"],
      () => `${Math.round((app.settings.font_scale ?? 1) * 100)}%`,
      (v) => {
        app.settings.font_scale = parseInt(v, 10) / 100;
        app.saveSettings();
        app.applyUiSettings();
      }, "Size of all interface text."));
    note("Scales every panel, label and button.");

    group("Interaction");
    add(checkbox("Dragged objects collide with walls",
      () => app.dragHitsWalls,
      (v) => app.setDragHitsWalls(v),
      "Stop a dragged body at walls instead of letting it pass through."));
    note("Off: a dragged body passes through walls, the quickest way to " +
         "place something on the far side of one. On: it is held outside " +
         "walls and slides along them, so you can push a ball up a ramp by " +
         "hand.");

    group("Accuracy & performance");
    add(checkbox("Performance mode",
      () => app.perfMode,
      (v) => app.setPerfMode(v),
      "Trade physical accuracy for frame rate across the whole app."));
    note("Off by default. Simplifies every part of the physics at once - " +
         "a cheaper integrator, fewer substeps and solver passes, no " +
         "adaptive time resolution - and draws springs as plain lines " +
         "without spin markers. Built for scenes you are playing with " +
         "rather than measuring: soft bodies, and crowds of objects piled " +
         "together, where it runs 5-8x faster. The energy graph will drift, " +
         "which is the trade working as intended; turn it off for anything " +
         "you want numbers from.");

    add(checkbox("Adaptive resolution",
      () => app.adaptiveDt,
      (v) => app.setAdaptiveDt(v),
      "Add extra, smaller physics steps through fast close encounters."));
    note("Recommended: Enabled. Keeps trajectories accurate and trails " +
         "smooth where a path curves sharply within one step, such as a " +
         "gravity slingshot. Substeps and iterations are separate, " +
         "per-scene settings in the Inspector's World tab. Performance mode " +
         "overrides this while it is on.");

    add(checkbox("Remove runaway objects",
      () => app.settings.cull ?? true,
      (v) => {
        app.settings.cull = v;
        app.saveSettings();
      }, "Delete bodies that have drifted far beyond any usable view."));
    note("Recommended: Enabled. Debris that will never return still costs " +
         "simulation time and pulls the auto-fit camera out. A body is " +
         "removed only once it is outside the widest possible view and " +
         "still receding, so bound orbits are never affected.");

    const helpRow = el("div", { class: "settings-actions" });
    helpRow.append(button("Replay the tour", () => {
      this.close();
      startTour();
    }, { tooltip: "Walk through the interface again from the start." }).root);
    helpRow.append(button("Help & shortcuts", () => {
      this.close();
      openHelp();
    }).root);
    const panel = el("div", { class: "overlay-panel settings-panel" },
      header, body, helpRow);
    this.focus = new ModalFocus(panel, "Settings");
    root.append(panel);
  }

  open(): void {
    this.visible = true;
    this.root.hidden = false;
    for (const c of this.controls) c.refresh?.();
    this.focus.enter();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.focus.exit();
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
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
    ["Right / Left (or . / ,)", "Step forward / back one frame"],
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
    ["\\", "Hide / show the inspector"],
    ["Tab", "Move between controls"],
    ["L", "Library"],
    ["F1", "This help"],
  ], "pc"],
  ["Mouse & touch", [
    ["Drag a body", "Move it; it keeps the motion it had"],
    ["Hold a body still", "Pin it while everything collides with it"],
    ["Drag the green arrow", "Set a body's velocity exactly"],
    ["Right-drag a body", "Aim its velocity vector", "pc"],
    ["Drag empty space", "Box select"],
    ["Pinch (touch)", "Zoom and pan"],
  ]],
];

/** The workflow, in the order someone new needs it. The shortcut tables
 * below answer "which key does X"; these answer "what do I do first",
 * which is the question the help overlay never used to address at all. */
const GETTING_STARTED: Array<[string, string, string]> = [
  ["1", "Open the Library",
   "47 worked examples across eight topics, each with a note on what it " +
   "shows. Loading one is the fastest way to see what this can do."],
  ["2", "Run it, then interfere",
   "Play, then drag something mid-flight. Nothing is on rails: lift a " +
   "planet out of its orbit, catch a pendulum at the top of its swing. A " +
   "dragged body keeps the motion it had, so moving something never throws " +
   "it - the green arrow is there when you do want to set a velocity."],
  ["3", "Build something",
   "Place two bodies and connect them. Clicking empty space with a rod, " +
   "string or spring creates the anchor or body you need, so a pendulum " +
   "is two clicks and a chain is a few more."],
  ["4", "Change the physics",
   "Select anything and the Inspector edits it live - mass, bounce, " +
   "friction. The World tab has gravity, air drag, N-body attraction and " +
   "custom force fields you write as formulas."],
  ["5", "Measure it",
   "The View tab turns on velocity and force arrows, motion trails, the " +
   "centre of mass, and live energy, momentum and phase-space graphs. The " +
   "status bar tracks total energy drift so you can see the solver working."],
  ["6", "Keep it",
   "Ctrl+S saves to this browser; the Library exports and imports .json, " +
   "which is the same format the desktop version used."],
];

export class Help {
  visible = false;
  private root: HTMLElement;
  private focus: ModalFocus;

  constructor(root: HTMLElement, startTour: () => void) {
    this.root = root;
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    // touch devices (phones and tablets) have no keyboard or mouse: hide
    // the shortcut sections and mouse-only rows, keep the touch gestures
    const touch = isTouch();
    const header = el("div", { class: "overlay-header" },
      el("h2", { text: touch ? "Help" : "Help & shortcuts" }));
    header.append(button("Take the tour", () => {
      this.close();
      startTour();
    }, { tooltip: "A guided walk through the interface." }).root);
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);

    // orientation first, reference second
    const startGrid = el("div", { class: "start-grid" });
    for (const [n, title, what] of GETTING_STARTED) {
      startGrid.append(el("div", { class: "start-step" },
        el("div", { class: "start-num", text: n }),
        el("div", {},
          el("h4", { text: title }),
          el("p", { text: what }))));
    }

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
      "margin-top:16px;font-size:calc(12px * var(--fs, 1));line-height:1.5" });
    about.textContent =
      "Mechanica is a 2D physics lab: rigid discs with rotation, walls, " +
      "rods, strings, springs, N-body gravity, drag, drivers and custom " +
      "force fields, integrated with symplectic solvers. Everything is in " +
      "SI units. All simulation runs locally in your browser.";
    const body = el("div", { class: "overlay-body" },
      el("h3", { class: "help-heading", text: "Getting started" }),
      startGrid,
      el("h3", { class: "help-heading",
                 text: touch ? "Gestures" : "Keys and gestures" }),
      cols, about);
    const panel = el("div", { class: "overlay-panel" }, header, body);
    this.focus = new ModalFocus(panel, "Help and shortcuts");
    root.append(panel);
  }

  open(): void {
    this.visible = true;
    this.root.hidden = false;
    this.focus.enter();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.focus.exit();
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }
}
