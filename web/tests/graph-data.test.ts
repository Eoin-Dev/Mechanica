/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, GraphMode } from "../src/app";
import { Body } from "../src/engine/body";
import { Vec2 } from "../src/core/vec";
import { PhasePlot, TimeSeries } from "../src/ui/plots";
import { GraphDataDialog, captureGraphData, downloadGraphData, graphCSV } from "../src/ui/graph-data";
import { button } from "../src/ui/dom";
import { GraphSnapshotChart } from "../src/ui/graph-view";

function source(mode: GraphMode = "Energy"): App {
  const body = new Body(new Vec2(7, -4), 0.2, 1);
  body.name = '=HYPERLINK("example", "name"), 📐';
  return {
    graphMode: mode, selection: [body],
    energySeries: new TimeSeries(["KE", "PE", "Total"]),
    momentumSeries: new TimeSeries(["|p|", "px", "py", "L"]),
    displacementSeries: new TimeSeries(["sx", "sy"]),
    distanceSeries: new TimeSeries(["Distance"]),
    velocitySeries: new TimeSeries(["Speed", "vx", "vy"]),
    phasePlot: new PhasePlot(),
    kinematicsReference: { bodyId: body.id, time: 2, x: 7, y: -4 },
  } as unknown as App;
}

const dialogs: GraphDataDialog[] = [];
afterEach(() => {
  dialogs.splice(0).forEach(dialog => dialog.close());
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("recorded graph data", () => {
  it.each([
    ["Energy", "energySeries", { KE: 1, PE: -2, Total: -1 },
      "time_s,kinetic_energy_J,potential_energy_J,total_energy_J"],
    ["Mom.", "momentumSeries", { "|p|": 5, px: -3, py: 4, L: -7 },
      "time_s,momentum_magnitude_kg_m_per_s,px_kg_m_per_s,py_kg_m_per_s,angular_momentum_about_com_kg_m2_per_s"],
    ["Displacement", "displacementSeries", { sx: -1, sy: 2 },
      "time_s,sx_m,sy_m,body_id,reference_time_s,reference_x_m,reference_y_m"],
    ["Distance", "distanceSeries", { Distance: 3 },
      "time_s,distance_m,body_id,reference_time_s,reference_x_m,reference_y_m"],
    ["Velocity", "velocitySeries", { Speed: 5, vx: -3, vy: 4 },
      "time_s,speed_m_per_s,vx_m_per_s,vy_m_per_s,body_id,reference_time_s,reference_x_m,reference_y_m"],
  ] as const)("exports %s channels with their physical units", (mode, key, values, header) => {
    const app = source(mode);
    app[key].add(2.5, values);
    app[key].hidden.add(app[key].channels[0]);
    const data = captureGraphData(app)!;
    const csv = graphCSV(data);
    expect(csv.split("\r\n")[0]).toBe(header);
    const row = csv.split("\r\n")[1].split(",").map(Number);
    expect(row.slice(0, 1 + Object.keys(values).length)).toEqual([2.5, ...Object.values(values)]);
    if (["Displacement", "Distance", "Velocity"].includes(mode)) {
      expect(row.slice(-4)).toEqual([app.selection[0].id, 2, 7, -4]);
      expect(data.body?.name).toBe((app.selection[0] as Body).name);
      expect(csv).not.toContain("HYPERLINK");
    }
    expect(csv).not.toContain("undefined");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("exports timestamped phase axes in the correct order and detaches its rows", () => {
    const app = source("Phase");
    app.phasePlot.add(2, 7, -3, -4, 4);
    const data = captureGraphData(app)!;
    app.phasePlot.points[0][0] = 999;
    app.phasePlot.clear();
    expect(data.rows).toEqual([[2, 7, -3, -4, 4]]);
    expect(graphCSV(data)).toBe(
      `time_s,x_m,vx_m_per_s,y_m,vy_m_per_s,body_id\r\n2,7,-3,-4,4,${app.selection[0].id}\r\n`);
  });

  it("reads only retained logical samples after eviction and truncation", () => {
    const app = source();
    app.energySeries = new TimeSeries(["KE", "PE", "Total"], 2, 4);
    for (let t = 0; t <= 10; t++) app.energySeries.add(t, { KE: t, PE: -t, Total: 0 });
    app.energySeries.truncate(9);
    expect(captureGraphData(app)!.rows).toEqual([[8, 8, -8, 0], [9, 9, -9, 0]]);
  });

  it("keeps a time-series snapshot independent of later updates and clearing", () => {
    const app = source();
    app.energySeries.add(0, { KE: 1 / 3, PE: -1e-9, Total: 1 / 3 - 1e-9 });
    const data = captureGraphData(app)!;
    const before = graphCSV(data);
    app.energySeries.add(0, { KE: 99, PE: 0, Total: 99 });
    app.energySeries.clear();
    expect(graphCSV(data)).toBe(before);
    expect(before).toContain("0.3333333333333333,-1e-9,0.3333333323333333");
  });

  it("captures an empty graph without inventing a zero-valued measurement", () => {
    const data = captureGraphData(source("Displacement"))!;
    expect(data.rows).toEqual([]);
    expect(graphCSV(data).split("\r\n")).toHaveLength(2);
    expect(captureGraphData(source("Off"))).toBeNull();
  });

  it("captures another graph family without changing the live dock", () => {
    const app = source();
    app.velocitySeries.add(2, { Speed: 5, vx: -3, vy: 4 });
    expect(captureGraphData(app, "Velocity")!.rows).toEqual([[2, 5, -3, 4]]);
    expect(app.graphMode).toBe("Energy");
  });

  it("quotes CSV header delimiters and rejects malformed or non-finite rows", () => {
    const data = captureGraphData(source())!;
    const columns = [{ label: "Quoted", csv: 'x,"value"' }];
    expect(graphCSV({ ...data, columns, rows: [[-0.25]] }))
      .toBe('"x,""value"""\r\n-0.25\r\n');
    for (const rows of [[[Infinity]], [[NaN]], [[]], [[1, 2]]]) {
      expect(() => graphCSV({ ...data, columns, rows })).toThrow();
    }
  });
});

describe("graph CSV downloads", () => {
  function downloads() {
    class RecordedBlob {
      readonly type: string;
      constructor(private parts: BlobPart[], options: BlobPropertyBag) { this.type = options.type!; }
      async text(): Promise<string> { return this.parts.join(""); }
    }
    const blobs: RecordedBlob[] = [];
    const create = vi.fn((blob: RecordedBlob) => { blobs.push(blob); return "blob:graph"; });
    const revoke = vi.fn();
    vi.stubGlobal("Blob", RecordedBlob);
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.useFakeTimers();
    return { blobs, create, revoke };
  }

  it("downloads exact CSV and releases the URL after the browser can fetch it", async () => {
    const { blobs, revoke } = downloads();
    const app = source();
    app.energySeries.add(1, { KE: 1, PE: 2, Total: 3 });
    const data = captureGraphData(app)!;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("mechanica-energy.csv");
      expect(this.href).toBe("blob:graph");
    });
    downloadGraphData(data);
    expect(click).toHaveBeenCalledOnce();
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    expect(await blobs[0].text()).toBe(graphCSV(data));
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:graph");
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it("releases an allocated URL even when the browser rejects the click", () => {
    const { revoke } = downloads();
    const app = source();
    app.energySeries.add(0, { KE: 0, PE: 0, Total: 0 });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("Blocked"); });
    expect(() => downloadGraphData(captureGraphData(app)!)).toThrow("Blocked");
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:graph");
  });

  it("does not allocate a download for an empty or malformed dataset", () => {
    const { create } = downloads();
    const data = captureGraphData(source())!;
    expect(() => downloadGraphData(data)).toThrow();
    expect(() => downloadGraphData({ ...data, rows: [[0, 1, 2, Infinity]] })).toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("graph data dialog", () => {
  function view(app = source()) {
    app.recordGraphSample = vi.fn();
    const root = document.createElement("div");
    root.hidden = true;
    document.body.append(root);
    const dialog = new GraphDataDialog(app, root);
    dialogs.push(dialog);
    return { app, dialog, root,
      exportButton: root.querySelector<HTMLButtonElement>("button.primary")!,
      status: root.querySelector<HTMLElement>('[role="status"]')!,
      pageButtons: [...root.querySelectorAll<HTMLButtonElement>(".graph-data-page-actions button")],
    };
  }

  it("pages a detached snapshot and keeps navigation controls stable", () => {
    const app = source();
    for (let i = 0; i < 51; i++) app.energySeries.add(i, { KE: i + 1 / 3, PE: -i, Total: 1 / 3 });
    const { dialog, root, status, pageButtons: [previous, next] } = view(app);
    dialog.open();
    expect(app.recordGraphSample).toHaveBeenCalledExactlyOnceWith(true);
    root.querySelectorAll<HTMLButtonElement>(".graph-data-view-buttons button")[1].click();
    expect(status.textContent).toBe("Samples 1–25 of 51");
    expect(previous.disabled).toBe(true);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(root.querySelector(".graph-data-pager")!.parentElement)
      .toBe(root.querySelector('[role="dialog"]'));
    app.energySeries.clear();
    dialog.open();
    expect(app.recordGraphSample).toHaveBeenCalledOnce();
    next.click();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(status.textContent).toBe("Samples 26–50 of 51");
    next.click();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.querySelector("tbody th")!.textContent).toBe("50");
    expect(status.textContent).toBe("Samples 51–51 of 51");
    expect(next.disabled).toBe(true);
    previous.click();
    expect(status.textContent).toBe("Samples 26–50 of 51");
    expect(root.querySelector(".graph-data-page-actions button")).toBe(previous);
    expect(root.querySelectorAll(".graph-data-page-actions button")[1]).toBe(next);
  });

  it("limits table DOM even when all 10000 retained measurements are available", () => {
    const app = source();
    app.energySeries = new TimeSeries(["KE", "PE", "Total"], 10000, 10000);
    for (let i = 0; i < 10000; i++) app.energySeries.add(i, { KE: i, PE: -i, Total: 0 });
    const { dialog, root, status } = view(app);
    dialog.open();
    expect(status.textContent).toBe("Samples 1–25 of 10000");
    expect(root.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(root.querySelectorAll("tbody td")).toHaveLength(75);
  });

  it("displays hostile names as text and explains the measurement reference", () => {
    const app = source("Displacement");
    (app.selection[0] as Body).name = '<img src="x" onerror="alert(1)"> ⚙️';
    app.displacementSeries.add(2.5, { sx: -0.25, sy: 1 / 3 });
    const { dialog, root } = view(app);
    dialog.open();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".graph-data-summary")!.textContent).toContain('<img src="x" onerror="alert(1)"> ⚙️');
    expect(root.querySelector(".graph-data-summary")!.textContent).toContain("t = 2 s · x = 7 m · y = -4 m");
    expect(root.querySelectorAll("tbody td")[1].textContent).toBe("0.333333333333");
    expect(root.querySelectorAll("tbody td")[1].getAttribute("title")).toBe("0.3333333333333333");
  });

  it("restores its logical opener and releases rows on button or backdrop dismissal", () => {
    const { dialog, root, app } = view();
    app.energySeries.add(0, { KE: 1, PE: 0, Total: 1 });
    const opener = button("Data", () => dialog.open()).root;
    document.body.append(opener);
    opener.click();
    expect(root.querySelector('[role="dialog"]')).toBe(document.activeElement);
    root.querySelector<HTMLButtonElement>('button[aria-label="Close graph data"]')!.click();
    expect(root.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(0);
    opener.click();
    root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(dialog.visible).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("retains a recoverable snapshot after a browser download error", () => {
    const { app, dialog, root, exportButton } = view();
    app.energySeries.add(1, { KE: 1, PE: 0, Total: 1 });
    const create = vi.fn(() => { throw new Error("Blocked"); });
    vi.stubGlobal("URL", { createObjectURL: create });
    dialog.open();
    exportButton.click();
    const error = root.querySelector<HTMLElement>('[role="alert"]')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("Your recorded data is still here");
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    app.energySeries.clear();
    exportButton.click();
    expect(create).toHaveBeenCalledTimes(2);
    expect(exportButton.disabled).toBe(false);
  });

  it("disables export for empty measurements and ignores an Off graph", () => {
    const { app, dialog, root, exportButton, status } = view(source("Displacement"));
    dialog.open();
    expect(exportButton.disabled).toBe(true);
    expect(status.textContent).toBe("No samples");
    expect(root.querySelector<HTMLElement>(".graph-data-empty")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".graph-data-table-region")!.hidden).toBe(true);
    dialog.close();
    app.graphMode = "Off";
    dialog.open();
    expect(dialog.visible).toBe(false);
    expect(root.hidden).toBe(true);
  });

  function click(root: HTMLElement, name: string): void {
    const control = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find(item => item.textContent === name || item.getAttribute("aria-label") === name);
    expect(control, name).toBeDefined(); control!.click();
  }

  it("opens a labelled graph and exposes numbers only on request", () => {
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: -2, Total: -1 });
    dialog.open();
    expect(root.querySelector<HTMLElement>(".graph-chart")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".graph-data-table-region")!.hidden).toBe(true);
    expect(root.querySelector(".graph-chart-surface svg")!.getAttribute("aria-label"))
      .toContain("Time (s) against Energy (J)");
    click(root, "Numbers");
    expect(root.querySelector<HTMLElement>(".graph-data-table-region")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".graph-chart")!.hidden).toBe(true);
    click(root, "Graph");
    expect(root.querySelector<HTMLElement>(".graph-chart")!.hidden).toBe(false);
  });

  it("navigates six fixed graph families without changing playback data or dock mode", () => {
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 });
    app.momentumSeries.add(0, { "|p|": 5, px: -3, py: 4, L: -7 });
    app.phasePlot.add(0, 7, -3, -4, 4);
    dialog.open(); app.momentumSeries.clear(); app.phasePlot.clear();
    for (const title of ["Momentum", "Phase space", "Displacement", "Distance travelled", "Velocity", "Energy"]) {
      click(root, "Next graph");
      expect(root.querySelector(".graph-data-heading h2")!.textContent).toBe(title);
    }
    click(root, "Previous graph");
    expect(root.querySelector(".graph-data-heading h2")!.textContent).toBe("Velocity");
    expect(app.graphMode).toBe("Energy");
    expect(app.recordGraphSample).toHaveBeenCalledOnce();
    click(root, "Next graph"); click(root, "Next graph");
    expect(root.querySelector("tbody td")!.textContent).toBe("5");
    expect(root.querySelectorAll("[data-channel]")).toHaveLength(3);
    click(root, "Angular");
    expect(root.querySelectorAll("[data-channel]")).toHaveLength(1);
    expect(root.querySelector(".graph-chart-surface svg")!.getAttribute("aria-label"))
      .toContain("Angular momentum (kg m²/s)");
    click(root, "Next graph"); click(root, "y–vy");
    expect(root.querySelector(".graph-chart-surface svg")!.getAttribute("aria-label"))
      .toContain("y (m) against vy (m/s)");
    root.querySelector(".graph-chart-surface")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(root.querySelector(".graph-chart-reading")!.textContent).toContain("y (m): -4");
    expect(root.querySelector(".graph-chart-reading")!.textContent).toContain("Time (s): 0");
  });

  it("hides chart channels without removing numbers or changing live visibility", () => {
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 }); dialog.open();
    click(root, "KE (J)");
    expect(root.querySelectorAll("[data-channel]")).toHaveLength(2);
    expect(root.querySelectorAll("tbody td")).toHaveLength(3);
    expect(app.energySeries.hidden.size).toBe(0);
    click(root, "PE (J)"); click(root, "Total (J)");
    expect(root.querySelector<HTMLButtonElement>(".graph-data-actions button:nth-child(2)")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(false);
    expect(root.querySelector(".graph-chart-reading")!.textContent).toContain("Choose a channel");
  });

  function imageDownloads() {
    const create = vi.fn(() => "blob:graph-png"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.useFakeTimers();
    const files: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      files.push(this.download);
    });
    return { create, files };
  }

  it("deduplicates PNG work and keeps the clicked graph's filename during navigation", async () => {
    const { files } = imageDownloads();
    let finish!: (blob: Blob) => void;
    const image = vi.spyOn(GraphSnapshotChart.prototype, "image").mockImplementation(
      () => new Promise(resolve => { finish = resolve; }));
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 });
    app.momentumSeries.add(0, { "|p|": 5, px: -3, py: 4, L: -7 });
    dialog.open(); click(root, "Export PNG"); click(root, "Export PNG");
    expect(image).toHaveBeenCalledOnce();
    click(root, "Next graph"); click(root, "Angular");
    finish(new Blob(["image"], { type: "image/png" })); await Promise.resolve();
    expect(files).toEqual(["mechanica-energy.png"]);
  });

  it("discards an unfinished PNG when its dialog closes and reopens", async () => {
    const { files } = imageDownloads();
    let finish!: (blob: Blob) => void;
    vi.spyOn(GraphSnapshotChart.prototype, "image").mockImplementation(
      () => new Promise(resolve => { finish = resolve; }));
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 });
    dialog.open(); click(root, "Export PNG"); dialog.close(); dialog.open();
    finish(new Blob(["image"])); await Promise.resolve();
    expect(files).toEqual([]);
    expect(root.querySelector<HTMLButtonElement>(".graph-data-actions button:nth-child(2)")!.disabled).toBe(false);
  });

  it("retains recorded data and permits retry after image rendering fails", async () => {
    const { files } = imageDownloads();
    vi.spyOn(GraphSnapshotChart.prototype, "image")
      .mockRejectedValueOnce(new Error("Rendering failed"))
      .mockResolvedValueOnce(new Blob(["image"]));
    const { app, dialog, root } = view();
    app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 });
    dialog.open(); click(root, "Export PNG"); await Promise.resolve();
    expect(root.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    click(root, "Export PNG"); await Promise.resolve();
    expect(files).toEqual(["mechanica-energy.png"]);
    expect(root.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(true);
  });
});
