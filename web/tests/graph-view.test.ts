/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphDataSnapshot } from "../src/ui/graph-data";
import { GraphSnapshotChart } from "../src/ui/graph-view";

const charts: GraphSnapshotChart[] = [];
afterEach(() => {
  charts.splice(0).forEach(chart => chart.clear());
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--fs");
});

function view() {
  const data: GraphDataSnapshot = {
    title: "Velocity", filename: "mechanica-velocity.csv",
    columns: [{ label: "Time (s)", csv: "time_s" }, { label: "Speed (m/s)", csv: "speed" },
      { label: "vx (m/s)", csv: "vx" }, { label: "vy (m/s)", csv: "vy" }],
    rows: [[0, 5, -3, 4], [0.25, 13, -5, 12], [0.5, 17, -8, 15]],
    body: { id: 2, name: "Particle", reference: { time: 0, x: 2, y: -3 } },
  };
  const chart = new GraphSnapshotChart(); charts.push(chart);
  document.body.append(chart.root); chart.set(data, 0);
  const surface = chart.root.querySelector<HTMLElement>(".graph-chart-surface")!;
  const reading = chart.root.querySelector<HTMLElement>(".graph-chart-reading")!;
  const key = (key: string) => surface.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { chart, data, surface, reading, key };
}

describe("detached graph rendering and inspection", () => {
  it("drags a zoomed viewport, clamps at its edges and releases the gesture", () => {
    const { chart, data, surface, key } = view();
    const rows = JSON.stringify(data.rows);
    const path = () => chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d");
    const original = path();
    key("+"); const zoomed = path();
    vi.spyOn(chart.root.querySelector("svg")!, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 640, height: 320, right: 640, bottom: 320, x: 0, y: 0, toJSON: () => ({}),
    });
    let paint: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { paint = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const pointer = (type: string, x: number, y: number, id = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: id, button: 0, clientX: x, clientY: y });
      surface.dispatchEvent(event); return event;
    };
    const capture = vi.fn(); surface.setPointerCapture = capture;
    surface.hasPointerCapture = () => true; surface.releasePointerCapture = vi.fn();
    expect(pointer("pointerdown", 320, 160).defaultPrevented).toBe(true);
    expect(capture).toHaveBeenCalledWith(1); expect(surface.classList.contains("panning")).toBe(true);
    pointer("pointermove", 420, 200, 2); expect(paint).toBeNull();
    pointer("pointermove", 420, 200); pointer("pointermove", 5000, 5000);
    expect(path()).toBe(zoomed); expect(paint).not.toBeNull();
    (paint as unknown as FrameRequestCallback)(0); expect(path()).not.toBe(zoomed);
    expect(chart.root.querySelector(".graph-zoom-level")!.textContent).toBe("2×");
    pointer("pointercancel", 5000, 5000);
    expect(surface.classList.contains("panning")).toBe(false);
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
    const panned = path(); pointer("pointermove", -5000, -5000); expect(path()).toBe(panned);
    key("0"); expect(path()).toBe(original); expect(surface.classList.contains("can-pan")).toBe(false);
    expect(JSON.stringify(data.rows)).toBe(rows);
  });

  it("supports keyboard panning without changing point-inspection arrow keys", () => {
    const { chart, surface, key, reading } = view();
    key("+"); const before = chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d");
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    expect(chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d")).not.toBe(before);
    key("End"); expect(reading.textContent).toContain("Speed (m/s): 17");
    key("ArrowLeft"); expect(reading.textContent).toContain("Time (s): 0.25");
  });
  it("zooms and resets the visible graph without changing recorded coordinates", () => {
    const { chart, data, key } = view();
    const rows = JSON.stringify(data.rows);
    const path = chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d");
    key("+");
    expect(chart.root.querySelector(".graph-zoom-level")!.textContent).toBe("2×");
    expect(chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d")).not.toBe(path);
    expect(chart.root.querySelector('[data-channel="speed"]')!.parentElement!.getAttribute("clip-path")).toMatch(/^url\(#graph-plot-clip-/);
    key("-"); expect(chart.root.querySelector(".graph-zoom-level")!.textContent).toBe("1×");
    key("+"); key("0");
    expect(chart.root.querySelector('[data-channel="speed"]')!.getAttribute("d")).toBe(path);
    expect(JSON.stringify(data.rows)).toBe(rows);
  });

  it("zooms under the pointer and leaves scrolling outside the plot alone", () => {
    const { chart, surface } = view();
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320, toJSON: () => ({}) };
    vi.spyOn(chart.root.querySelector("svg")!, "getBoundingClientRect").mockReturnValue(rect);
    const wheel = new WheelEvent("wheel", { clientX: 320, clientY: 160, deltaY: -200, cancelable: true });
    surface.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(chart.root.querySelector(".graph-zoom-level")!.textContent).not.toBe("1×");
    const outside = new WheelEvent("wheel", { clientX: -10, clientY: 160, deltaY: -200, cancelable: true });
    surface.dispatchEvent(outside); expect(outside.defaultPrevented).toBe(false);
  });
  it("labels physical axes and provides distinct path patterns", () => {
    const { chart } = view();
    expect(chart.root.querySelector("svg")!.textContent).toContain("Velocity (m/s)");
    expect(chart.root.querySelector("svg")!.textContent).toContain("Time (s)");
    const paths = [...chart.root.querySelectorAll("[data-channel]")];
    expect(paths.map(path => path.getAttribute("stroke-dasharray"))).toEqual(["", "8 4", "2 4"]);
    expect(paths.every(path => !path.getAttribute("d")!.includes("NaN"))).toBe(true);
  });

  it("inspects stored coordinates by keyboard without interpolating or changing rows", () => {
    const { chart, data, key, reading } = view();
    const before = JSON.stringify(data.rows);
    key("End"); expect(reading.textContent).toContain("Time (s): 0.5");
    expect(reading.textContent).toContain("Speed (m/s): 17");
    key("ArrowDown"); expect(reading.textContent).toContain("vx (m/s): -8");
    key("ArrowLeft"); expect(reading.textContent).toContain("Time (s): 0.25");
    expect(reading.textContent).toContain("vx (m/s): -5");
    key("Home"); key("ArrowLeft"); expect(reading.textContent).toContain("Time (s): 0");
    expect(reading.getAttribute("aria-live")).toBe("polite");
    expect(chart.root.querySelector("g circle")).not.toBeNull();
    expect(JSON.stringify(data.rows)).toBe(before);
  });

  it.each(["pointerleave", "blur"])("clears inspection on %s", event => {
    const { chart, surface, key, reading } = view();
    key("End"); surface.dispatchEvent(new Event(event));
    expect(reading.textContent).toContain("Hover or use arrow keys");
    expect(chart.root.querySelector("g circle")).toBeNull();
  });

  it("refreshes visible axis size and font on preference changes and releases observation", async () => {
    const stop = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { chart, surface } = view(); chart.observe();
    expect(chart.root.querySelector('[title="Zoom in graph"]')!.getAttribute("aria-label")).toBe("Zoom in graph");
    expect(chart.root.querySelector('[title="Reset graph zoom"]')!.getAttribute("aria-label")).toContain("Fit");
    surface.style.setProperty("--fs", "2");
    surface.style.fontFamily = "OpenDyslexic, sans-serif";
    document.documentElement.style.setProperty("--fs", "2");
    await Promise.resolve();
    const caption = surface.querySelector("svg text")!;
    expect(caption.getAttribute("font-size")).toBe("24");
    expect(caption.getAttribute("font-family")).toContain("OpenDyslexic");
    chart.clear(); expect(stop).toHaveBeenCalledOnce();
  });

  it("disconnects resizing and releases chart content on dismissal", () => {
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
    const { chart } = view(); chart.observe(); chart.observe();
    expect(observe).toHaveBeenCalledOnce(); chart.clear();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(chart.root.querySelector("svg")).toBeNull();
    expect(chart.root.querySelectorAll(".graph-chart-channel")).toHaveLength(0);
    expect(chart.canExport).toBe(false);
  });
});

describe("portable graph image export", () => {
  function rendering(failure?: "render" | "context" | "encode") {
    const create = vi.fn(() => "blob:detached-svg"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_src: string) { queueMicrotask(() => failure === "render" ? this.onerror?.() : this.onload?.()); }
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      failure === "context" ? null : { drawImage } as unknown as CanvasRenderingContext2D);
    const blob = new Blob(["PNG"], { type: "image/png" });
    const encoding = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      callback => callback(failure === "encode" ? null : blob));
    const serializing = vi.spyOn(XMLSerializer.prototype, "serializeToString");
    return { create, revoke, drawImage, blob, encoding, serializing };
  }

  it("exports labelled axes, channels and reference metadata at 2400 by 1440", async () => {
    const { blob, encoding, serializing, drawImage, revoke } = rendering();
    const { chart } = view();
    expect(await chart.image()).toBe(blob);
    const svg = serializing.mock.calls[0][0] as SVGSVGElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1200 720");
    expect(svg.textContent).toContain("Velocity · 3 recorded samples");
    expect(svg.textContent).toContain("Particle ID 2 · Reference: 0 s; (2, -3) m");
    expect(svg.textContent).toContain("Speed (m/s)");
    expect((encoding.mock.instances[0] as HTMLCanvasElement).width).toBe(2400);
    expect((encoding.mock.instances[0] as HTMLCanvasElement).height).toBe(1440);
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 2400, 1440]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:detached-svg");
  });

  it.each(["render", "context", "encode"] as const)("releases the SVG URL on %s failure", async failure => {
    const { revoke } = rendering(failure);
    const { chart } = view();
    await expect(chart.image()).rejects.toThrow();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:detached-svg");
    expect(chart.canExport).toBe(true);
  });

  it("does not allocate an export when all channels are hidden", async () => {
    const { create } = rendering();
    const { chart } = view();
    chart.root.querySelectorAll<HTMLButtonElement>(".graph-chart-channel").forEach(button => button.click());
    await expect(chart.image()).rejects.toThrow("visible samples");
    expect(create).not.toHaveBeenCalled();
  });
});
