/** Modal overlays: the library (example presets + saved scenes), and help. */
import { App } from "../app";
import { CATEGORIES, PRESETS } from "../scene/presets";
import * as snap from "../scene/snapshot";
import { Control, ModalFocus, button, checkbox, el, isTouch, refreshTabs,
         fmt3dp, numEdit, segmented, wireTabs } from "./dom";
import { ICONS } from "./icons";
import { ThemeName, css, defaultAccent } from "./theme";

// ------------------------------------------------------------------ library
type LibraryTab = "Examples" | "My scenes";
interface SceneEditor {
  kind: "save" | "rename" | "description" | "delete";
  name: string;
  value: string;
  replacement: string | null;
}

export class Library {
  visible = false;
  private app: App;
  private root: HTMLElement;
  private focus!: ModalFocus;
  private tab: LibraryTab = "Examples";
  private category = "All";
  private search = "";
  private tabBtns = new Map<LibraryTab, HTMLButtonElement>();
  private content!: HTMLElement;
  private importRequest: AbortController | null = null;
  private importButton: HTMLButtonElement | null = null;
  private sceneEditor: SceneEditor | null = null;

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
    this.sceneEditor = null;
    const request = this.importRequest;
    this.importRequest = null;
    request?.abort();
    this.syncImportButton();
    this.root.hidden = true;
    this.focus.exit();
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  private build(): void {
    const header = el("div", { class: "overlay-header library-header" },
      el("h2", { text: "Library" }));
    const tabs = el("div", { class: "tabs library-tabs",
                             "aria-label": "Library sections" });
    for (const t of ["Examples", "My scenes"] as const) {
      const b = el("button", { text: t, id: `library-tab-${t === "Examples" ? "examples" : "scenes"}`,
                                "aria-controls": "library-panel" });
      b.addEventListener("click", () => {
        this.tab = t;
        this.render();
      });
      this.tabBtns.set(t, b);
      tabs.append(b);
    }
    wireTabs(tabs, this.tabBtns, (tab) => {
      this.tab = tab;
      this.render();
    });
    header.append(tabs);
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);

    this.content = el("div", { class: "overlay-body", id: "library-panel",
                               role: "tabpanel", tabindex: "0" });
    const panel = el("div", { class: "overlay-panel" }, header, this.content);
    this.focus = new ModalFocus(panel, "Library");
    this.root.append(panel);
  }

  private render(): void {
    refreshTabs(this.tabBtns, this.tab, this.content);
    // Do not retain a detached action when tabs replace the panel. If a file
    // read is still pending, renderScenes binds the new button to the same
    // instance-level request below.
    this.importButton = null;
    this.content.replaceChildren();
    if (this.tab === "Examples") this.renderExamples();
    else this.renderScenes();
  }

  // ------------------------------------------------------------- examples
  private renderExamples(): void {
    const search = el("input", { type: "search", class: "library-search-input",
      placeholder: "Search examples", "aria-label": "Search examples" });
    search.value = this.search;
    const searchIcon = el("span", { class: "library-search-icon", "aria-hidden": "true" });
    searchIcon.insertAdjacentHTML("beforeend", ICONS.search);
    const clear = button("", () => {
      this.search = "";
      search.value = "";
      populate();
      search.focus();
    }, { icon: ICONS.close, style: "ghost", class: "library-search-clear",
      tooltip: "Clear example search" }).root;
    const searchField = el("div", { class: "library-search-field" }, searchIcon, search, clear);
    const resultCount = el("span", { class: "faint library-result-count",
      role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const searchRow = el("div", { class: "library-search" }, searchField, resultCount);
    const chips = el("div", { class: "cat-chips", role: "group",
                               "aria-label": "Example categories" });
    for (const cat of CATEGORIES) {
      const on = cat === this.category;
      const b = el("button", { text: cat, "aria-pressed": String(on) });
      b.dataset.category = cat;
      if (on) b.classList.add("active");
      b.addEventListener("click", () => {
        const keepFocus = document.activeElement === b;
        this.category = cat;
        this.render();
        if (keepFocus) {
          const next = [...this.content.querySelectorAll<HTMLButtonElement>("[data-category]")]
            .find((candidate) => candidate.dataset.category === cat);
          next?.focus();
        }
      });
      chips.append(b);
    }
    const grid = el("div", { class: "card-grid" });
    this.content.append(searchRow, chips, grid);
    const populate = (): void => {
      grid.replaceChildren();
      clear.hidden = this.search.length === 0;
      const words = this.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const presets = PRESETS.filter(preset =>
        (this.category === "All" || preset.category === this.category) &&
        words.every(word => `${preset.name} ${preset.category} ${preset.description}`
          .toLowerCase().includes(word)));
      resultCount.textContent = `${presets.length} ${presets.length === 1 ? "example" : "examples"}`;
      if (presets.length === 0) {
        grid.append(el("p", { class: "faint library-empty",
          text: "No examples match this search in the selected category." }),
          button("Clear search", () => {
            this.search = "";
            search.value = "";
            populate();
            search.focus();
          }).root);
      }
      this.renderExampleCards(grid, presets);
    };
    search.addEventListener("input", () => {
      this.search = search.value;
      populate();
    });
    populate();
  }

  private renderExampleCards(grid: HTMLElement, presets: typeof PRESETS): void {
    // Descriptions are clamped to a few lines; where one is truncated we add a
    // "Show more" toggle (mouse- or keyboard-activated) to reveal the full text
    // without loading the preset. Whether it's needed can only be measured once
    // the cards are laid out, so collect them and check after appending.
    const clampable: Array<{ desc: HTMLElement; card: HTMLElement }> = [];
    let descriptionIndex = 0;
    for (const preset of presets) {
      const desc = el("p", { text: preset.description,
                              id: `preset-description-${descriptionIndex++}` });
      const card = el("div", { class: "preset-card",
                               "data-preset-name": preset.name },
        el("div", { class: "cat", text: preset.category }),
        el("h3", { text: preset.name }), desc);
      const load = el("button", { class: "preset-card-hit",
                                   "aria-label": `Load ${preset.name}`,
                                   "aria-describedby": desc.id });
      load.addEventListener("click", () => {
        this.app.loadPreset(preset);
        this.close();
      });
      card.append(load);
      grid.append(card);
      clampable.push({ desc, card });
    }
    for (const { desc, card } of clampable) {
      if (desc.scrollHeight <= desc.clientHeight + 1) continue; // fully visible
      const more = el("button", { class: "card-more", text: "Show more",
                                   "aria-expanded": "false",
                                   "aria-controls": desc.id });
      more.addEventListener("click", () => {
        const open = card.classList.toggle("expanded");
        more.textContent = open ? "Show less" : "Show more";
        more.setAttribute("aria-expanded", String(open));
      });
      card.classList.add("has-more");
      card.append(more);
    }
  }

  // ----------------------------------------------------------- saved scenes
  private renderScenes(): void {
    const app = this.app;
    const actions = el("div", { class: "cat-chips library-scenes-actions" });
    actions.append(button("Save current scene", () => {
      this.openSceneEditor("save", "", `Scene ${new Date().toISOString().slice(0, 10)}`);
    }, { icon: ICONS.save }).root);
    const imported = button("Import .json", async () => {
      if (this.importRequest !== null) return;
      const request = new AbortController();
      this.importRequest = request;
      this.syncImportButton();
      try {
        const result = await snap.uploadScene(request.signal);
        if (this.importRequest !== request || request.signal.aborted) return;
        switch (result.status) {
          case "cancelled": return;
          case "loaded":
            app.loadWorld(result.world, result.name);
            this.close();
            return;
          case "too-large":
          case "storage-error":
            app.toast(result.message);
            return;
          case "missing":
          case "invalid":
            app.toast(`Could not read '${result.name}' as a Mechanica scene`);
            return;
        }
      } catch {
        if (this.importRequest === request && !request.signal.aborted) {
          app.toast("Could not import the scene file. Try again.");
        }
      } finally {
        if (this.importRequest === request) {
          this.importRequest = null;
          this.syncImportButton();
        }
      }
    }, { icon: ICONS.import,
         tooltip: "Load a .json scene saved from this app or the desktop " +
                   "version." });
    this.importButton = imported.root as HTMLButtonElement;
    this.syncImportButton();
    actions.append(imported.root);
    this.content.append(actions);
    if (this.sceneEditor !== null) this.renderSceneEditor(this.sceneEditor);

    let names: string[];
    try {
      names = snap.listScenes();
    } catch (exc) {
      this.content.append(el("div", { class: "faint",
        style: "margin-top:14px",
        text: exc instanceof snap.SceneSaveError ? exc.message
                                                 : "Saved scenes are unavailable" }));
      return;
    }
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
      const card = el("div", { class: "preset-card scene-card", "data-scene-name": name },
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
                                 title: tooltip, "aria-label": tooltip });
        b.insertAdjacentHTML("beforeend", icon);
        b.addEventListener("click", stop(fn));
        return b;
      };
      bar.append(mkBtn(ICONS.rename, `Rename ${name}`, () =>
        this.openSceneEditor("rename", name, name)));
      bar.append(mkBtn(ICONS.describe, `${desc ? "Edit" : "Add"} description for ${name}`, () =>
        this.openSceneEditor("description", name, desc)));
      bar.append(mkBtn(ICONS.download, `Download ${name} as a .json file`, () => {
        const result = snap.loadScene(name);
        if (result.status === "loaded") {
          try {
            snap.downloadScene(result.world, name);
          } catch (exc) {
            app.toast(exc instanceof snap.SceneSaveError ? exc.message
                                                         : "Could not download the scene");
          }
        }
        else if (result.status === "too-large" || result.status === "storage-error") {
          app.toast(result.message);
        } else {
          app.toast(`Could not read saved scene '${name}'`);
        }
      }));
      bar.append(mkBtn(ICONS.trash, `Delete saved scene ${name}`, () =>
        this.openSceneEditor("delete", name, ""), true));
      card.append(button(`Load ${name}`, () => {
        const result = snap.loadScene(name);
        if (result.status === "loaded") {
          app.loadWorld(result.world, name);
          this.close();
        } else if (result.status === "too-large" || result.status === "storage-error") {
          app.toast(result.message);
        } else {
          app.toast(`Could not load '${name}': the saved data is missing or damaged`);
        }
      }, { style: "primary", class: "card-load" }).root, bar);
      grid.append(card);
    }
    this.content.append(grid);
  }

  private openSceneEditor(kind: SceneEditor["kind"], name: string, value: string): void {
    this.sceneEditor = { kind, name, value, replacement: null };
    this.render();
    const field = this.content.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      ".scene-editor input, .scene-editor textarea");
    if (field !== null) {
      field.focus();
      field.select();
    } else {
      this.content.querySelector<HTMLButtonElement>(".scene-editor-cancel")?.focus();
    }
  }

  private focusScene(name: string): void {
    const card = [...this.content.querySelectorAll<HTMLElement>(".scene-card")]
      .find(candidate => candidate.dataset.sceneName === name);
    if (card !== undefined) card.querySelector<HTMLButtonElement>(".card-load")?.focus();
    else [...this.content.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.textContent === "Save current scene")?.focus();
  }

  private cancelSceneEditor(): void {
    const name = this.sceneEditor?.name ?? "";
    this.sceneEditor = null;
    this.render();
    this.focusScene(name);
  }

  private renderSceneEditor(editor: SceneEditor): void {
    const titles = { save: "Save current scene", rename: "Rename scene",
      description: "Scene description", delete: "Delete saved scene" };
    const labels = { save: "Save scene", rename: "Rename scene",
      description: "Save description", delete: "Delete saved scene" };
    const form = el("form", { class: "scene-editor", "aria-labelledby": "scene-editor-title" });
    form.append(el("h3", { id: "scene-editor-title", text: titles[editor.kind] }));
    if (editor.name !== "") form.append(el("p", { class: "faint",
      text: editor.kind === "delete"
        ? `Delete “${editor.name}” and its description from this browser?`
        : `Editing “${editor.name}”` }));
    const help = el("p", { class: "faint", id: "scene-editor-help" });
    const error = el("p", { class: "scene-editor-error", id: "scene-editor-error",
      role: "alert", hidden: "" });
    const warning = el("p", { class: "scene-editor-warning", role: "status", hidden: "" });
    let field: HTMLInputElement | HTMLTextAreaElement | null = null;
    const submit = el("button", { type: "submit", class: editor.kind === "delete" ? "danger" : "primary",
      text: labels[editor.kind] });
    const cancel = button("Cancel", () => this.cancelSceneEditor(),
      { class: "scene-editor-cancel" }).root as HTMLButtonElement;
    cancel.type = "button";
    if (editor.kind !== "delete") {
      field = editor.kind === "description"
        ? el("textarea", { rows: "3" }) : el("input", { type: "text", autocomplete: "off" });
      field.id = "scene-editor-value";
      field.value = editor.value;
      field.setAttribute("aria-describedby", "scene-editor-help scene-editor-error");
      form.append(el("label", { class: "scene-editor-field" },
        el("span", { text: editor.kind === "description" ? "Description" : "Scene name" }), field));
      const update = (): void => {
        editor.value = field!.value;
        error.hidden = true;
        field!.removeAttribute("aria-invalid");
        if (editor.kind === "description") {
          help.textContent = "Leave this empty to remove the description.";
        } else {
          const normalized = snap.normalizeSceneName(editor.value);
          help.textContent = editor.value.trim() !== "" && normalized !== editor.value
            ? `Saved as “${normalized}”. Names keep letters, numbers, spaces, underscores and hyphens, up to 80 characters.`
            : "Use letters, numbers, spaces, underscores and hyphens, up to 80 characters.";
        }
      };
      field.addEventListener("input", () => {
        editor.replacement = null;
        warning.hidden = true;
        submit.textContent = labels[editor.kind];
        update();
      });
      update();
      form.append(help);
    }
    const showReplacement = (): void => {
      warning.textContent = `“${editor.replacement}” already exists. Replace its saved scene?`;
      warning.hidden = false;
      submit.textContent = "Replace scene";
    };
    if (editor.replacement !== null) showReplacement();
    form.append(warning, error, el("div", { class: "scene-editor-actions" }, cancel, submit));
    form.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.cancelSceneEditor();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const fail = (message: string, invalid = false): void => {
        error.textContent = message;
        error.hidden = false;
        if (invalid && field !== null) {
          field.setAttribute("aria-invalid", "true");
          field.focus();
        }
      };
      if ((editor.kind === "save" || editor.kind === "rename") && editor.value.trim() === "") {
        fail("Enter a scene name.", true);
        return;
      }
      let name = editor.name;
      try {
        switch (editor.kind) {
          case "save": {
            const normalized = snap.normalizeSceneName(editor.value);
            if (snap.sceneExists(normalized) && editor.replacement !== normalized) {
              editor.replacement = normalized;
              showReplacement();
              cancel.focus();
              return;
            }
            name = snap.saveScene(this.app.world, editor.value);
            this.app.toast(`Saved scene '${name}'`);
            break;
          }
          case "rename": {
            const renamed = snap.renameScene(editor.name, editor.value);
            if (renamed === null) {
              fail("A scene with that name already exists, or the original scene is no longer available.", true);
              return;
            }
            name = renamed;
            this.app.toast(`Renamed to '${name}'`);
            break;
          }
          case "description": snap.setSceneDescription(name, editor.value); break;
          case "delete": snap.deleteScene(name); break;
        }
      } catch (exc) {
        fail(exc instanceof snap.SceneSaveError ? exc.message : "Could not update the saved scene");
        return;
      }
      this.sceneEditor = null;
      this.render();
      this.focusScene(name);
    });
    this.content.append(form);
  }

  private syncImportButton(): void {
    if (this.importButton === null) return;
    const importing = this.importRequest !== null;
    this.importButton.disabled = importing;
    this.importButton.setAttribute("aria-busy", String(importing));
  }
}

// ----------------------------------------------------------------- settings
const THEME_LABELS: Array<[string, ThemeName]> = [
  ["Void", "void"], ["Dark", "dark"], ["Light", "light"],
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
    //
    // Appearance is the deliberate exception: every control in it is a matter
    // of taste whose effect is visible the instant it is clicked, so they
    // carry tooltips and no notes. Accent colour keeps its note because it is
    // the one Appearance setting whose SCOPE is not obvious - people
    // reasonably expect it to recolour the physics objects, and it does not.
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
    add(checkbox("Studio mode",
      () => app.settings.studio_mode ?? false,
      (v) => {
        app.settings.studio_mode = v;
        app.saveSettings();
        app.applyUiSettings();
      }, "Add layered gradients, rounded workspace styling and stronger boundaries over the selected colour theme."));

    // accent colour: preset swatch circles + a custom picker. UI chrome
    // and highlights only - physics object colours are never touched.
    label("Accent colour");
    const swatchRow = el("div", { class: "swatch-row", role: "group",
                                  "aria-label": "Accent colour" });
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
      // Choosing or removing a colour rebuilds this compact list. Preserve
      // keyboard focus across that replacement so activation does not dump
      // the user back at the start of the Settings dialog.
      const focused = swatchRow.contains(document.activeElement)
        ? document.activeElement as HTMLElement : null;
      const focusedChoice = focused?.dataset.accentChoice;
      const focusedAction = focused?.dataset.accentAction;
      swatchRow.replaceChildren();
      const current = app.settings.accent ?? null;
      const mkSwatch = (hex: string | null, tip: string, colour: string,
                        deletable = false): void => {
        const selected = hex === current;
        const b = el("button", { class: "swatch", title: tip,
                                 "aria-label": tip,
                                 "aria-pressed": String(selected) });
        b.dataset.accentChoice = hex ?? "theme-default";
        b.append(el("span", { class: "dot", style: `background:${colour}` }));
        if (selected) b.classList.add("active");
        b.addEventListener("click", () => applyAccent(hex));
        if (deletable) {
          const item = el("div", { class: "swatch-item" }, b);
          const x = el("button", { class: "swatch-remove", text: "×",
                                    title: `Remove saved colour ${hex}`,
                                    "aria-label": `Remove saved colour ${hex}` });
          x.dataset.accentAction = "remove";
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            app.settings.custom_accents =
              (app.settings.custom_accents ?? []).filter((h) => h !== hex);
            // deleting the colour in use falls back to the theme default
            applyAccent(app.settings.accent === hex ? null
                                                    : app.settings.accent ?? null);
          });
          item.append(x);
          swatchRow.append(item);
        } else {
          swatchRow.append(b);
        }
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
                                    title: "Create a custom colour",
                                    "aria-label": "Create a custom accent colour" });
      addBtn.dataset.accentAction = "add";
      addBtn.addEventListener("click", () => {
        colorInput.value = app.settings.accent ?? "#8b5cf6";
        popover.hidden = false;
      });
      swatchRow.append(addBtn);
      if (focused !== null) {
        const choices = [...swatchRow.querySelectorAll<HTMLElement>(
          "[data-accent-choice]")];
        const restore = focusedChoice !== undefined
          ? choices.find((candidate) => candidate.dataset.accentChoice === focusedChoice)
          : focusedAction === "add" ? addBtn
            // A removed button no longer exists. Land on the active colour,
            // or on Add if the setting fell back and no match is present.
            : choices.find((candidate) => candidate.getAttribute("aria-pressed") === "true")
              ?? addBtn;
        restore?.focus();
      }
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

    label("Font size");
    const fontScale = segmented(["90%", "100%", "110%", "120%"],
      () => `${Math.round((app.settings.font_scale ?? 1) * 100)}%`,
      (v) => {
        app.settings.font_scale = parseInt(v, 10) / 100;
        app.saveSettings();
        app.applyUiSettings();
      }, "Size of all interface text.");
    fontScale.root.classList.add("font-scale-options");
    add(fontScale);

    group("Interaction");
    add(checkbox("Dragged objects collide with walls",
      () => app.dragHitsWalls,
      (v) => app.setDragHitsWalls(v),
      "Stop a dragged body at walls instead of letting it pass through."));
    note("Off: a dragged body passes through walls, the quickest way to " +
         "place something on the far side of one. On: it is held outside " +
         "walls and slides along them, so you can push a ball up a ramp by " +
         "hand.");

    group("New scene defaults");
    add(numEdit("Gravity after Clear", () => app.newSceneGravity,
      (value) => app.setNewSceneGravity(value), "m/s²", undefined, fmt3dp));
    note("Defaults to 9.8 m/s². This is applied only when the toolbar's Clear " +
         "button creates an empty workspace; premades and imported scenes " +
         "keep their own gravity.");

    group("Accuracy & performance");
    add(checkbox("Performance mode",
      () => app.perfMode,
      (v) => app.setPerfMode(v),
      "Trade physical accuracy for frame rate across the whole app."));
    note("Off by default. Sacrifices physical accuracy heavily for speed, " +
         "and overrides the scene's own solver settings. It automatically " +
         "reduces canvas sharpness, physics frequency, collision/constraint " +
         "work and gravity accuracy until the machine can keep up. Resting " +
         "unlinked bodies may sleep. Don't use it to model anything " +
         "accurately or to read numbers off.");

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
    ["B / A", "Add body / anchor (anchors support nearby rods)"],
    ["W", "Draw wall (Shift snaps the angle)"],
    ["R / E / S / P", "Connect rod / string / spring; add pulley"],
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
    ["Graph: Distance", "Distance travelled by the selected particle over time"],
    ["Graph: Velocity", "Speed and x/y velocity of the selected particle over time"],
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
   "48 worked examples across eight topics, each with a note on what it " +
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
   "Select a particle for live position, displacement, distance, velocity, " +
   "acceleration and free-body arrows drawn on the canvas. World records and " +
    "pauses at events; Graphs adds energy, momentum, phase space, " +
    "distance–time and velocity–time plots."],
  ["6", "Keep it",
   "Refreshing restores this tab's last checkpoint, paused. Ctrl+S saves " +
   "a named scene to this browser; the Library exports and imports .json, " +
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
    const header = el("div", { class: "overlay-header help-header" },
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
    about.append(
      "Mechanica is a 2D physics lab: rigid discs with rotation, walls, " +
      "rods, strings, springs, N-body gravity, drag, drivers and custom " +
      "force fields, integrated with symplectic solvers. Everything is in " +
      "SI units. All simulation runs locally in your browser.");
    about.append(" ", el("a", { href: "./THIRD_PARTY_NOTICES.txt",
                                  target: "_blank", rel: "noopener",
                                  text: "Third-party notices" }));
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
