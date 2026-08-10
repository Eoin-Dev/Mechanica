import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const quick = process.argv.includes("--quick");
const warmupMs = quick ? 700 : 1500;
const sampleMs = quick ? 1200 : 3000;
const dprs = quick ? [1] : [1, 2];
const scenarios = quick ? [
  ["empty", "empty"],
  ["two-body collision", "simple"],
  ["gas 200", "gas", 200],
] : [
  ["empty", "empty"],
  ["two-body collision", "simple"],
  ["friction ramp", "preset", "Friction ramp"],
  ["resting/impact stack", "preset", "Wrecking ball"],
  ["gas 50", "gas", 50],
  ["gas 200", "gas", 200],
  ["gas 500", "gas", 500],
  ["gas 1000", "gas", 1000],
  ["gas 2000", "gas", 2000],
  ["spring lattice", "preset", "Jelly block"],
  ["rope", "preset", "Swinging rope"],
  ["mutual gravity", "preset", "Orbit dance"],
];

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const dpr of dprs) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: dpr,
    });
    await context.addInitScript(() => {
      localStorage.setItem("mechanica.settings", JSON.stringify({
        tour_done: true,
        inspector_visible: false,
        cull: false,
      }));
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:4174/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__mechanica?.benchmark !== undefined);

    for (const [scene, kind, arg] of scenarios) {
      for (const mode of ["normal", "maximum"]) {
        await page.evaluate(({ kind: loader, arg: value, mode: selected }) => {
          const { app, benchmark } = window.__mechanica;
          if (app.playing) app.togglePlay();
          if (loader === "empty") benchmark.loadEmpty();
          else if (loader === "simple") benchmark.loadSimpleCollision();
          else if (loader === "gas") benchmark.loadGas(value);
          else benchmark.loadPreset(value);
          app.setPerfMode(selected === "maximum");
          if (selected === "maximum") benchmark.forcePerformanceLevel(3);
          if (!app.playing) app.togglePlay();
        }, { kind, arg, mode });
        await page.waitForTimeout(warmupMs);
        const sample = await page.evaluate(async (durationMs) => {
          const frames = [];
          const telemetry = [];
          const started = performance.now();
          let previous = started;
          let lastTelemetry = -Infinity;
          await new Promise((resolve) => {
            const frame = (now) => {
              frames.push(now - previous);
              previous = now;
              if (now - lastTelemetry >= 200) {
                telemetry.push(window.__mechanica.benchmark.snapshot());
                lastTelemetry = now;
              }
              if (now - started >= durationMs) resolve();
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          return { frames, telemetry };
        }, sampleMs);
        const latest = sample.telemetry.at(-1);
        results.push({
          scene,
          mode,
          dpr,
          bodies: latest.bodies,
          adaptiveLevel: latest.level,
          fps: Number((1000 / percentile(sample.frames, 0.5)).toFixed(1)),
          p95FrameMs: Number(percentile(sample.frames, 0.95).toFixed(2)),
          physicsMs: Number(percentile(sample.telemetry.map((x) => x.physicsMs), 0.5).toFixed(2)),
          renderMs: Number(percentile(sample.telemetry.map((x) => x.renderMs), 0.5).toFixed(2)),
          contacts: latest.contacts,
          canvasMegapixels: Number((latest.canvasPixels / 1_000_000).toFixed(2)),
        });
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.table(results);
console.log(JSON.stringify({
  environment: {
    browser: "bundled Chromium",
    viewport: "1280x720",
    warmupMs,
    sampleMs,
    generatedAt: new Date().toISOString(),
  },
  results,
}, null, 2));
