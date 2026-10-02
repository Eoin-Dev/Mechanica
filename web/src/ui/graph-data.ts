/** Detached graph inspection, portable exports and a bounded coordinate table. */
import type { App, GraphMode } from "../app";
import { GraphSnapshotChart } from "./graph-view";
import { Body } from "../engine/body";
import { ModalFocus, button, countNoun, el } from "./dom";
import { ICONS } from "./icons";
import type { TimeSeries } from "./plots";

export interface GraphColumn {
  label: string;
  csv: string;
}

export interface GraphDataSnapshot {
  title: string;
  filename: string;
  columns: readonly GraphColumn[];
  rows: readonly (readonly number[])[];
  description?: string;
  body?: {
    id: number;
    name: string;
    reference?: { time: number; x: number; y: number };
  };
}

/** Copy retained logical samples, including channels hidden in the plot.
 * No live arrays or body references escape into the resulting snapshot. */
export function captureGraphData(app: App, mode: GraphMode = app.graphMode): GraphDataSnapshot | null {
  let series: TimeSeries;
  let title: string;
  let filename: string;
  let columns: GraphColumn[];
  let description: string | undefined;
  const time = { label: "Time (s)", csv: "time_s" };
  const reference = app.kinematicsReference;
  let body: GraphDataSnapshot["body"];
  if (mode === "Phase") {
    const selected = app.selection.find((item): item is Body => item instanceof Body);
    return {
      title: "Phase space", filename: "mechanica-phase.csv",
      columns: [time, { label: "x (m)", csv: "x_m" },
        { label: "vx (m/s)", csv: "vx_m_per_s" },
        { label: "y (m)", csv: "y_m" }, { label: "vy (m/s)", csv: "vy_m_per_s" }],
      rows: app.phasePlot.points.map(([x, vx, y, vy, t]) => [t, x, vx, y, vy]),
      body: selected ? { id: selected.id, name: selected.name } : undefined,
    };
  }
  switch (mode) {
    case "Energy":
      series = app.energySeries; title = "Energy"; filename = "mechanica-energy.csv";
      columns = [time, { label: "KE (J)", csv: "kinetic_energy_J" },
        { label: "PE (J)", csv: "potential_energy_J" },
        { label: "Total (J)", csv: "total_energy_J" }];
      break;
    case "Mom.":
      series = app.momentumSeries; title = "Momentum"; filename = "mechanica-momentum.csv";
      description = "L is angular momentum about the system's centre of mass, including spin. Positive is anticlockwise.";
      columns = [time, { label: "|p| (kg m/s)", csv: "momentum_magnitude_kg_m_per_s" },
        { label: "px (kg m/s)", csv: "px_kg_m_per_s" },
        { label: "py (kg m/s)", csv: "py_kg_m_per_s" },
        { label: "L about CoM (kg m²/s)", csv: "angular_momentum_about_com_kg_m2_per_s" }];
      break;
    case "Displacement":
      series = app.displacementSeries; title = "Displacement"; filename = "mechanica-displacement.csv";
      columns = [time, { label: "sx (m)", csv: "sx_m" }, { label: "sy (m)", csv: "sy_m" }];
      break;
    case "Distance":
      series = app.distanceSeries; title = "Distance travelled"; filename = "mechanica-distance.csv";
      columns = [time, { label: "Distance (m)", csv: "distance_m" }];
      break;
    case "Velocity":
      series = app.velocitySeries; title = "Velocity"; filename = "mechanica-velocity.csv";
      columns = [time, { label: "Speed (m/s)", csv: "speed_m_per_s" },
        { label: "vx (m/s)", csv: "vx_m_per_s" }, { label: "vy (m/s)", csv: "vy_m_per_s" }];
      break;
    default: return null;
  }
  if (["Displacement", "Distance", "Velocity"].includes(mode) && reference) {
    const selected = app.selection.find((item): item is Body =>
      item instanceof Body && item.id === reference.bodyId);
    if (selected) body = { id: selected.id, name: selected.name,
      reference: { time: reference.time, x: reference.x, y: reference.y } };
  }
  return { title, filename, columns, body, description,
    rows: Array.from({ length: series.count }, (_, i) =>
      [series.timeAt(i), ...series.channels.map(channel => series.valueAt(channel, i))]),
  };
}

/** Fixed numeric identity/reference columns keep measurements self-contained
 * without putting arbitrary scene names into spreadsheet cells or filenames. */
export function graphCSV(data: GraphDataSnapshot): string {
  const headers = data.columns.map(column => column.csv);
  const metadata: number[] = [];
  if (data.body) {
    headers.push("body_id"); metadata.push(data.body.id);
    if (data.body.reference) {
      headers.push("reference_time_s", "reference_x_m", "reference_y_m");
      const { time, x, y } = data.body.reference;
      metadata.push(time, x, y);
    }
  }
  if (!data.columns.length || metadata.some(value => !Number.isFinite(value))) {
    throw new Error("The recorded graph contains invalid values.");
  }
  const quote = (value: string): string => /[,"\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"` : value;
  const rows = [headers.map(quote).join(",")];
  for (const row of data.rows) {
    if (row.length !== data.columns.length || row.some(value => !Number.isFinite(value))) {
      throw new Error("The recorded graph contains invalid values.");
    }
    rows.push([...row, ...metadata].map(String).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

/** Trigger a local download and release its temporary browser URL on every path. */
export function downloadGraphData(data: GraphDataSnapshot): void {
  if (!data.rows.length) throw new Error("There are no recorded samples to export.");
  const csv = graphCSV(data);
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), data.filename);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: filename });
  try { document.body.append(anchor); anchor.click(); }
  finally {
    anchor.remove();
    // Let the browser begin reading the local URL before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

const PAGE_SIZE = 25;
function preview(value: number): string { return String(Number(value.toPrecision(12))); }

const GRAPH_VIEWS = ["Energy", "Mom.", "Phase", "Displacement", "Distance", "Velocity"] as const;
type SnapshotMode = typeof GRAPH_VIEWS[number];

export class GraphDataDialog {
  visible = false;
  private data: GraphDataSnapshot | null = null;
  private snapshots = new Map<SnapshotMode, GraphDataSnapshot>();
  private mode: SnapshotMode = "Energy";
  private numbers = false;
  private variant = 0;
  private page = 0;
  private focus: ModalFocus;
  private title: HTMLElement;
  private heading: HTMLElement;
  private summary: HTMLElement;
  private head: HTMLElement;
  private rows: HTMLElement;
  private tableRegion: HTMLElement;
  private empty: HTMLElement;
  private pager: HTMLElement;
  private pageStatus: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private previousGraph: HTMLButtonElement;
  private nextGraph: HTMLButtonElement;
  private graphButton: HTMLButtonElement;
  private numbersButton: HTMLButtonElement;
  private variants: HTMLElement;
  private exportButton: HTMLButtonElement;
  private imageButton: HTMLButtonElement;
  private imageBusy = false;
  private exportEpoch = 0;
  private error: HTMLElement;
  private interpretation: HTMLElement;
  private chart = new GraphSnapshotChart();

  constructor(private app: App, private root: HTMLElement) {
    const header = el("div", { class: "overlay-header graph-data-header" });
    this.title = el("span", { class: "dim graph-data-kind", "aria-live": "polite", "aria-atomic": "true" });
    this.heading = el("h2", { text: "Graph data" });
    header.append(el("div", { class: "graph-data-heading" },
      this.heading, this.title));
    const actions = el("div", { class: "graph-data-actions" });
    this.exportButton = button("Export CSV", () => this.export(),
      { icon: ICONS.download, style: "primary" }).root as HTMLButtonElement;
    this.imageButton = button("Export PNG", () => { void this.exportImage(); },
      { icon: ICONS.download }).root as HTMLButtonElement;
    actions.append(this.exportButton, this.imageButton, button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close graph data" }).root);
    header.append(actions);
    this.summary = el("div", { class: "graph-data-summary" });
    this.interpretation = el("p", { class: "dim graph-data-note", hidden: "" });
    this.error = el("p", { class: "graph-data-error", role: "alert", hidden: "" });
    this.head = el("thead"); this.rows = el("tbody");
    this.tableRegion = el("div", { class: "graph-data-table-region", role: "region",
      "aria-label": "Recorded graph samples", tabindex: "0" },
      el("table", { class: "graph-data-table" },
        el("caption", { class: "sr-only", text: "Recorded graph values in SI units" }), this.head, this.rows));
    this.empty = el("p", { class: "graph-data-empty", text: "No recorded samples. Select a particle or run the simulation, then open Data again." });
    this.pageStatus = el("span", { role: "status", "aria-live": "polite", "aria-atomic": "true" });
    this.previous = button("Previous", () => this.turnPage(-1),
      { icon: ICONS.chev_left }).root as HTMLButtonElement;
    this.next = button("Next", () => this.turnPage(1),
      { icon: ICONS.chev_right }).root as HTMLButtonElement;
    this.pager = el("div", { class: "graph-data-pager", role: "group", "aria-label": "Sample pages" },
      this.pageStatus, el("div", { class: "graph-data-page-actions" }, this.previous, this.next));
    this.graphButton = button("Graph", () => this.setNumbers(false)).root as HTMLButtonElement;
    this.numbersButton = button("Numbers", () => this.setNumbers(true)).root as HTMLButtonElement;
    this.variants = el("div", { class: "graph-data-variants", role: "group", "aria-label": "Graph axes" });
    const choices = el("div", { class: "graph-data-toolbar" },
      el("div", { class: "graph-data-view-buttons", role: "group", "aria-label": "Graph or numbers" },
        this.graphButton, this.numbersButton), this.variants);
    const body = el("div", { class: "overlay-body graph-data-body" }, choices,
      this.interpretation, this.error, this.empty, this.chart.root, this.tableRegion,
      this.summary, el("p", { class: "dim graph-data-note", text: "Fixed measurements from the simulation clock. Numbers preview 12 significant figures; CSV retains full stored precision." }));
    this.previousGraph = button("", () => this.turnGraph(-1),
      { icon: ICONS.chev_left, tooltip: "Previous graph", class: "graph-switch graph-switch-previous" }).root as HTMLButtonElement;
    this.nextGraph = button("", () => this.turnGraph(1),
      { icon: ICONS.chev_right, tooltip: "Next graph", class: "graph-switch graph-switch-next" }).root as HTMLButtonElement;
    const panel = el("div", { class: "overlay-panel graph-data-panel" }, header,
      this.previousGraph, this.nextGraph, body, this.pager);
    root.append(panel); this.focus = new ModalFocus(panel, "Graph data");
    this.chart.onChange = () => this.updateImageButton();
    root.addEventListener("pointerdown", event => { if (event.target === root) this.close(); });
  }

  open(): void {
    if (this.visible || this.app.graphMode === "Off") return;
    this.app.recordGraphSample(true);
    for (const mode of GRAPH_VIEWS) {
      const data = captureGraphData(this.app, mode);
      if (data) this.snapshots.set(mode, data);
    }
    const mode = this.app.graphMode as SnapshotMode;
    if (!this.snapshots.has(mode)) return;
    this.visible = true; this.root.hidden = false; this.numbers = false;
    this.imageBusy = false; this.exportEpoch++;
    this.selectGraph(mode); this.focus.enter();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false; this.root.hidden = true; this.exportEpoch++;
    this.focus.exit(); this.chart.clear(); this.snapshots.clear(); this.data = null;
    this.rows.replaceChildren(); this.summary.replaceChildren(); this.variants.replaceChildren();
    this.imageBusy = false;
  }

  private selectGraph(mode: SnapshotMode): void {
    const data = this.snapshots.get(mode); if (!data) return;
    this.mode = mode; this.data = data; this.page = 0; this.variant = 0;
    const index = GRAPH_VIEWS.indexOf(mode);
    this.heading.textContent = data.title;
    this.title.textContent = `Graph data · ${index + 1} of ${GRAPH_VIEWS.length}`;
    this.previousGraph.title = `Previous graph: ${this.snapshots.get(GRAPH_VIEWS[(index + GRAPH_VIEWS.length - 1) % GRAPH_VIEWS.length])!.title}`;
    this.nextGraph.title = `Next graph: ${this.snapshots.get(GRAPH_VIEWS[(index + 1) % GRAPH_VIEWS.length])!.title}`;
    this.interpretation.textContent = data.description ?? ""; this.interpretation.hidden = !data.description;
    this.error.hidden = true; this.error.textContent = "";
    this.summary.replaceChildren();
    const detail = (label: string, text: string): void => {
      this.summary.append(el("div", { class: "graph-data-detail" },
        el("span", { class: "dim", text: label }), el("strong", { text })));
    };
    detail("Recorded", countNoun(data.rows.length, "sample"));
    if (data.rows.length) detail("Time window", `${preview(data.rows[0][0])}–${preview(data.rows.at(-1)![0])} s`);
    if (data.body) {
      detail("Particle", `${data.body.name} · ID ${data.body.id}`);
      const ref = data.body.reference;
      if (ref) detail("Measurement reference", `t = ${preview(ref.time)} s · x = ${preview(ref.x)} m · y = ${preview(ref.y)} m`);
    }
    const headings = el("tr");
    for (const column of data.columns) headings.append(el("th", { scope: "col", text: column.label }));
    this.head.replaceChildren(headings);
    this.exportButton.disabled = data.rows.length === 0; this.empty.hidden = data.rows.length > 0;
    this.variants.replaceChildren();
    const labels = mode === "Mom." ? ["Linear", "Angular"] : mode === "Phase" ? ["x–vx", "y–vy"] : [];
    for (const [index, label] of labels.entries()) {
      const item = button(label, () => {
        this.variant = index;
        for (const [i, child] of [...this.variants.children].entries()) {
          child.setAttribute("aria-pressed", String(i === index)); child.classList.toggle("active", i === index);
        }
        this.chart.set(data, this.variant); this.updateImageButton();
      }).root;
      item.setAttribute("aria-pressed", String(index === 0)); item.classList.toggle("active", index === 0);
      this.variants.append(item);
    }
    this.variants.hidden = labels.length === 0;
    this.chart.set(data, 0); this.renderPage(); this.setNumbers(this.numbers);
  }

  private turnGraph(direction: number): void {
    const index = (GRAPH_VIEWS.indexOf(this.mode) + direction + GRAPH_VIEWS.length) % GRAPH_VIEWS.length;
    this.selectGraph(GRAPH_VIEWS[index]);
  }

  private setNumbers(numbers: boolean): void {
    this.numbers = numbers;
    this.graphButton.setAttribute("aria-pressed", String(!numbers)); this.graphButton.classList.toggle("active", !numbers);
    this.numbersButton.setAttribute("aria-pressed", String(numbers)); this.numbersButton.classList.toggle("active", numbers);
    const hasRows = (this.data?.rows.length ?? 0) > 0;
    this.tableRegion.hidden = !numbers || !hasRows; this.pager.hidden = !numbers || !hasRows;
    this.chart.root.hidden = numbers || !hasRows; this.variants.hidden = numbers || this.variants.children.length === 0;
    if (!numbers && hasRows) this.chart.observe();
  }

  private turnPage(direction: number): void {
    if (!this.data) return;
    this.page = Math.max(0, Math.min(Math.ceil(this.data.rows.length / PAGE_SIZE) - 1, this.page + direction));
    this.renderPage(); this.tableRegion.scrollTop = 0;
  }

  private renderPage(): void {
    if (!this.data) return;
    const start = this.page * PAGE_SIZE, end = Math.min(this.data.rows.length, start + PAGE_SIZE);
    const rows = document.createDocumentFragment();
    for (const row of this.data.rows.slice(start, end)) {
      const tr = el("tr");
      row.forEach((number, i) => tr.append(el(i === 0 ? "th" : "td",
        { ...(i === 0 ? { scope: "row" } : {}), text: preview(number), title: String(number) })));
      rows.append(tr);
    }
    this.rows.replaceChildren(rows); this.previous.disabled = this.page === 0; this.next.disabled = end >= this.data.rows.length;
    this.pageStatus.textContent = this.data.rows.length ? `Samples ${start + 1}–${end} of ${this.data.rows.length}` : "No samples";
  }

  private updateImageButton(): void { this.imageButton.disabled = this.imageBusy || !this.chart.canExport; }

  private async exportImage(): Promise<void> {
    if (!this.data || !this.chart.canExport || this.imageBusy) return;
    const data = this.data, epoch = this.exportEpoch, variant = this.variant;
    const suffix = this.mode === "Mom." ? variant === 1 ? "-angular" : "-linear"
      : this.mode === "Phase" ? variant === 1 ? "-y-vy" : "-x-vx" : "";
    this.imageBusy = true; this.updateImageButton();
    try {
      const image = await this.chart.image();
      if (!this.visible || this.exportEpoch !== epoch) return;
      downloadBlob(image, data.filename.replace(/\.csv$/, `${suffix}.png`));
      this.error.hidden = true; this.error.textContent = "";
    } catch {
      if (this.visible && this.exportEpoch === epoch) {
        this.error.textContent = "Could not export the image. Your recorded data is still here; try Export PNG again.";
        this.error.hidden = false;
      }
    } finally {
      if (this.exportEpoch === epoch) { this.imageBusy = false; this.updateImageButton(); }
    }
  }

  private export(): void {
    if (!this.data?.rows.length) return;
    try { downloadGraphData(this.data); this.error.hidden = true; this.error.textContent = ""; }
    catch {
      this.error.textContent = "Could not start the download. Your recorded data is still here; try Export CSV again.";
      this.error.hidden = false;
    }
  }
}
