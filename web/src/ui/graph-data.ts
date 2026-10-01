/** Detached graph measurements, portable CSV and a bounded native data table. */
import type { App } from "../app";
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
export function captureGraphData(app: App): GraphDataSnapshot | null {
  let series: TimeSeries;
  let title: string;
  let filename: string;
  let columns: GraphColumn[];
  let description: string | undefined;
  const time = { label: "Time (s)", csv: "time_s" };
  const reference = app.kinematicsReference;
  let body: GraphDataSnapshot["body"];
  if (app.graphMode === "Phase") {
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
  switch (app.graphMode) {
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
  if (["Displacement", "Distance", "Velocity"].includes(app.graphMode) && reference) {
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
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = el("a", { href: url, download: data.filename });
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Immediate revocation can race the browser's download request.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

const PAGE_SIZE = 25;
function preview(value: number): string { return String(Number(value.toPrecision(12))); }

export class GraphDataDialog {
  visible = false;
  private data: GraphDataSnapshot | null = null;
  private page = 0;
  private focus: ModalFocus;
  private title: HTMLElement;
  private summary: HTMLElement;
  private head: HTMLElement;
  private rows: HTMLElement;
  private tableRegion: HTMLElement;
  private empty: HTMLElement;
  private pageStatus: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private exportButton: HTMLButtonElement;
  private error: HTMLElement;
  private interpretation: HTMLElement;

  constructor(private app: App, private root: HTMLElement) {
    const header = el("div", { class: "overlay-header graph-data-header" });
    this.title = el("span", { class: "dim graph-data-kind" });
    header.append(el("div", { class: "graph-data-heading" },
      el("h2", { text: "Graph data" }), this.title));
    const actions = el("div", { class: "graph-data-actions" });
    this.exportButton = button("Export CSV", () => this.export(),
      { icon: ICONS.download, style: "primary" }).root as HTMLButtonElement;
    actions.append(this.exportButton, button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close graph data" }).root);
    header.append(actions);
    this.summary = el("div", { class: "graph-data-summary" });
    this.interpretation = el("p", { class: "dim graph-data-note", hidden: "" });
    this.error = el("p", { class: "graph-data-error", role: "alert", hidden: "" });
    this.head = el("thead");
    this.rows = el("tbody");
    this.tableRegion = el("div", { class: "graph-data-table-region", role: "region",
      "aria-label": "Recorded graph samples", tabindex: "0" },
      el("table", { class: "graph-data-table" },
        el("caption", { class: "sr-only", text: "Recorded graph values in SI units" }),
        this.head, this.rows));
    this.empty = el("p", { class: "graph-data-empty", text: "No recorded samples. Select a particle or run the simulation, then open Data again." });
    this.pageStatus = el("span", { role: "status", "aria-live": "polite", "aria-atomic": "true" });
    this.previous = button("Previous", () => this.turnPage(-1),
      { icon: ICONS.chev_left }).root as HTMLButtonElement;
    this.next = button("Next", () => this.turnPage(1),
      { icon: ICONS.chev_right }).root as HTMLButtonElement;
    const pager = el("div", { class: "graph-data-pager", role: "group", "aria-label": "Sample pages" },
      this.pageStatus, el("div", { class: "graph-data-page-actions" }, this.previous, this.next));
    const body = el("div", { class: "overlay-body graph-data-body" }, this.summary,
      el("p", { class: "dim graph-data-note", text: "A fixed snapshot of all retained samples, including hidden channels. Preview: 12 significant figures. CSV: full stored precision. Time is the simulation clock." }),
      this.interpretation, this.error, this.empty, this.tableRegion);
    const panel = el("div", { class: "overlay-panel graph-data-panel" }, header, body, pager);
    root.append(panel);
    this.focus = new ModalFocus(panel, "Graph data");
    root.addEventListener("pointerdown", event => { if (event.target === root) this.close(); });
  }

  open(): void {
    if (this.visible || this.app.graphMode === "Off") return;
    this.app.recordGraphSample(true);
    const data = captureGraphData(this.app);
    if (!data) return;
    this.data = data;
    this.page = 0;
    this.title.textContent = data.title;
    this.interpretation.textContent = data.description ?? "";
    this.interpretation.hidden = !data.description;
    this.error.hidden = true;
    this.error.textContent = "";
    this.summary.replaceChildren();
    const detail = (label: string, value: string): void => {
      this.summary.append(el("div", { class: "graph-data-detail" },
        el("span", { class: "dim", text: label }), el("strong", { text: value })));
    };
    detail("Recorded", countNoun(data.rows.length, "sample"));
    if (data.rows.length) detail("Time window", `${preview(data.rows[0][0])}–${preview(data.rows.at(-1)![0])} s`);
    if (data.body) {
      detail("Particle", `${data.body.name} · ID ${data.body.id}`);
      const reference = data.body.reference;
      if (reference) detail("Measurement reference",
        `t = ${preview(reference.time)} s · x = ${preview(reference.x)} m · y = ${preview(reference.y)} m`);
    }
    const headings = el("tr");
    for (const column of data.columns) headings.append(el("th", { scope: "col", text: column.label }));
    this.head.replaceChildren(headings);
    this.exportButton.disabled = data.rows.length === 0;
    this.tableRegion.hidden = data.rows.length === 0;
    this.empty.hidden = data.rows.length > 0;
    this.renderPage();
    this.visible = true;
    this.root.hidden = false;
    this.focus.enter();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.focus.exit();
    this.data = null;
    this.rows.replaceChildren();
    this.summary.replaceChildren();
  }

  private turnPage(direction: number): void {
    if (!this.data) return;
    this.page = Math.max(0, Math.min(Math.ceil(this.data.rows.length / PAGE_SIZE) - 1, this.page + direction));
    this.renderPage();
    this.tableRegion.scrollTop = 0;
  }

  private renderPage(): void {
    if (!this.data) return;
    const start = this.page * PAGE_SIZE;
    const end = Math.min(this.data.rows.length, start + PAGE_SIZE);
    const rows = document.createDocumentFragment();
    for (const row of this.data.rows.slice(start, end)) {
      const tr = el("tr");
      row.forEach((value, i) => tr.append(el(i === 0 ? "th" : "td",
        { ...(i === 0 ? { scope: "row" } : {}), text: preview(value), title: String(value) })));
      rows.append(tr);
    }
    this.rows.replaceChildren(rows);
    this.previous.disabled = this.page === 0;
    this.next.disabled = end >= this.data.rows.length;
    this.pageStatus.textContent = this.data.rows.length
      ? `Samples ${start + 1}–${end} of ${this.data.rows.length}` : "No samples";
  }

  private export(): void {
    if (!this.data || !this.data.rows.length) return;
    try {
      downloadGraphData(this.data);
      this.error.hidden = true;
      this.error.textContent = "";
    } catch {
      this.error.textContent = "Could not start the download. Your recorded data is still here; try Export CSV again.";
      this.error.hidden = false;
    }
  }
}
